import { createDecipheriv, createHash, createHmac, pbkdf2, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export interface DatabaseSnapshotOptions {
  sourcePath: string
  destinationPath: string
  /** A passphrase, or a 32-byte hexadecimal key. Never persisted or logged. */
  key: string
  signal?: AbortSignal
  /** Progress is measured in database bytes, excluding WAL headers. */
  onProgress?: (done: number, total: number) => void
}

export interface DatabaseSnapshotResult {
  encrypted: boolean
  walApplied: boolean
  /** Recovery stopped on damage, rather than normal obsolete WAL generations. */
  partial: boolean
  warnings: string[]
  format: string
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii')
const SALT_SIZE = 16
const KEY_SIZE = 32
const HMAC_SALT_MASK = 0x3a
// Bound temporary buffers while amortizing FileHandle/worker round trips.
const IO_BATCH_BYTES = 1024 * 1024

interface CipherProfile {
  name: string
  pageSize: number
  reserve: number
  digest: 'sha512' | 'sha1'
  iterations: number
  macSize: number
}

// Public SQLCipher format parameters, not code from a third-party decryptor.
// https://www.zetetic.net/sqlcipher/design/
// SQLCipher 3 uses SHA-1, 64,000 KDF iterations and a 48-byte reserve.
const PROFILES: readonly CipherProfile[] = [
  { name: 'SQLCipher4', pageSize: 4096, reserve: 80, digest: 'sha512', iterations: 256000, macSize: 64 },
  { name: 'WeChat3', pageSize: 4096, reserve: 48, digest: 'sha1', iterations: 64000, macSize: 20 },
  { name: 'WeChat3', pageSize: 1024, reserve: 48, digest: 'sha1', iterations: 64000, macSize: 20 },
]

class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'DatabaseSnapshotError' }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('读取数据库已取消')
    error.name = 'AbortError'
    throw error
  }
}

function report(options: DatabaseSnapshotOptions, done: number, total: number): void {
  checkAbort(options.signal)
  options.onProgress?.(done, total)
  checkAbort(options.signal)
}

async function derive(password: Buffer, salt: Buffer, iterations: number, digest: string, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal)
  const key = await new Promise<Buffer>((accept, reject) => {
    pbkdf2(password, salt, iterations, KEY_SIZE, digest, (error, output) => error ? reject(error) : accept(output))
  })
  if (signal?.aborted) { key.fill(0); checkAbort(signal) }
  return key
}

async function readExactly(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await file.read(data, offset, size - offset, position + offset)
    if (bytesRead === 0) throw new SnapshotError('数据库在读取时被截断，请关闭微信后重试')
    offset += bytesRead
  }
  return data
}

async function writeExactly(file: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset)
    if (!bytesWritten) throw new SnapshotError('无法写入数据库快照')
    offset += bytesWritten
  }
}

type FileStamp = Awaited<ReturnType<typeof fileStamp>>
async function fileStamp(path: string) {
  try {
    const value = await stat(path, { bigint: true })
    if (!value.isFile()) throw new SnapshotError('所选数据库或附属文件不是普通文件')
    return { size: value.size, mtime: value.mtimeNs, ctime: value.ctimeNs, ino: value.ino, dev: value.dev }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  if (!a || !b) return a === b
  return a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.ino === b.ino && a.dev === b.dev
}

async function stamps(path: string) {
  const [db, wal, journal] = await Promise.all([fileStamp(path), fileStamp(`${path}-wal`), fileStamp(`${path}-journal`)])
  if (!db) throw new SnapshotError('所选数据库不存在')
  return { db, wal, journal }
}

type SourceStamps = Awaited<ReturnType<typeof stamps>>
function sourceUnchanged(a: SourceStamps, b: SourceStamps): boolean {
  return sameStamp(a.db, b.db) && sameStamp(a.wal, b.wal) && sameStamp(a.journal, b.journal)
}

function rejectJournal(value: SourceStamps): void {
  if (value.journal && value.journal.size > 0n) {
    throw new SnapshotError('数据库存在非空回滚日志，无法保证一致读取；请正常退出微信后重试')
  }
}

async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, 'r')
  const chunk = Buffer.alloc(1024 * 1024)
  const hash = createHash('sha256')
  try {
    const size = (await file.stat()).size
    if (!Number.isSafeInteger(size)) throw new SnapshotError('数据库或 WAL 文件过大')
    let position = 0
    while (position < size) {
      checkAbort(signal)
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position)
      if (!bytesRead) break
      hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally { chunk.fill(0); await file.close() }
}

async function pairDigest(path: string, hasWal: boolean, signal?: AbortSignal): Promise<string> {
  const values = await Promise.allSettled([fileDigest(path, signal), hasWal ? fileDigest(`${path}-wal`, signal) : Promise.resolve('absent')])
  for (const value of values) if (value.status === 'rejected') throw value.reason
  return values.map(value => (value as PromiseFulfilledResult<string>).value).join(':')
}

/** Never give SQLite the live DB or SHM. Accept only an unchanged DB/WAL pair.
 * Win32 can defer mtime updates while WeChat retains a write handle. Check the
 * full contents before/after copying as well as file identity and metadata.
 */
async function stableCopy(options: DatabaseSnapshotOptions, stage: string): Promise<{ path: string; stamps: SourceStamps }> {
  const path = join(stage, 'source.db')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    checkAbort(options.signal)
    const before = await stamps(options.sourcePath)
    rejectJournal(before)
    await rm(path, { force: true })
    await rm(`${path}-wal`, { force: true })
    try {
      const digestBefore = await pairDigest(options.sourcePath, Boolean(before.wal), options.signal)
      await copyFile(options.sourcePath, path, constants.COPYFILE_EXCL)
      await chmod(path, 0o600)
      if (before.wal) {
        await copyFile(`${options.sourcePath}-wal`, `${path}-wal`, constants.COPYFILE_EXCL)
        await chmod(`${path}-wal`, 0o600)
      }
      const digests = await Promise.allSettled([
        pairDigest(options.sourcePath, Boolean(before.wal), options.signal),
        pairDigest(path, Boolean(before.wal), options.signal),
      ])
      for (const value of digests) if (value.status === 'rejected') throw value.reason
      const [digestAfter, digestCopy] = digests.map(value => (value as PromiseFulfilledResult<string>).value)
      checkAbort(options.signal)
      const after = await stamps(options.sourcePath)
      rejectJournal(after)
      if (sourceUnchanged(before, after) && digestBefore === digestAfter && digestBefore === digestCopy) return { path, stamps: after }
    } catch (error) {
      checkAbort(options.signal)
      // A checkpoint may remove the WAL while we copy it. Retry that race;
      // retain permission/IO errors instead of treating them as a valid copy.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  throw new SnapshotError('数据库或 WAL 仍在变化，无法取得一致快照；请暂停收发消息后重试')
}

function verifyMac(page: Buffer, pageNumber: number, profile: CipherProfile, macKey: Buffer): boolean {
  const start = pageNumber === 1 ? SALT_SIZE : 0
  const reserveStart = profile.pageSize - profile.reserve
  const number = Buffer.alloc(4)
  number.writeUInt32LE(pageNumber)
  const expected = createHmac(profile.digest, macKey)
    .update(page.subarray(start, reserveStart + 16)).update(number).digest()
  const stored = page.subarray(reserveStart + 16, reserveStart + 16 + profile.macSize)
  return expected.length === stored.length && timingSafeEqual(expected, stored)
}

function decryptPage(page: Buffer, pageNumber: number, profile: CipherProfile, encryptionKey: Buffer, macKey: Buffer): Buffer {
  if (!verifyMac(page, pageNumber, profile, macKey)) {
    throw new SnapshotError(`数据库第 ${pageNumber} 页认证失败；文件可能已损坏或读取时仍在变化`)
  }
  const start = pageNumber === 1 ? SALT_SIZE : 0
  const end = profile.pageSize - profile.reserve
  const decipher = createDecipheriv('aes-256-cbc', encryptionKey, page.subarray(end, end + 16))
  decipher.setAutoPadding(false)
  const plaintext = Buffer.concat([decipher.update(page.subarray(start, end)), decipher.final()])
  const result = Buffer.alloc(profile.pageSize)
  if (pageNumber === 1) SQLITE_HEADER.copy(result)
  plaintext.copy(result, start)
  plaintext.fill(0)
  // Keep header byte 20: SQLite b-tree usable size still excludes this reserve.
  // Only the IV/HMAC/padding bytes are replaced with zeros.
  return result
}

function validHeader(page: Buffer, profile: CipherProfile): boolean {
  return page.subarray(0, 16).equals(SQLITE_HEADER) && page.readUInt16BE(16) === profile.pageSize &&
    (page[18] === 1 || page[18] === 2) && (page[19] === 1 || page[19] === 2) &&
    page[20] === profile.reserve && page[21] === 64 && page[22] === 32 && page[23] === 32
}

interface MatchedCipher { profile: CipherProfile; key: Buffer; macKey: Buffer; mode: string }

async function findCipher(file: FileHandle, size: number, keyText: string, signal?: AbortSignal, rawOnly = false): Promise<MatchedCipher> {
  if (!keyText) throw new SnapshotError('此数据库已加密，请提供对应数据库密钥')
  const firstBytes = await readExactly(file, Math.min(4096, size), 0)
  const salt = firstBytes.subarray(0, SALT_SIZE)
  const macSalt = Buffer.from(Array.from(salt, byte => byte ^ HMAC_SALT_MASK))
  const hex = /^[a-f\d]{64}$/i.test(keyText) ? Buffer.from(keyText, 'hex') : null
  const text = Buffer.from(keyText, 'utf8')
  try {
    // Most WeChat keys are raw keys. Check every supported raw format before
    // spending hundreds of thousands of KDF rounds on any passphrase format.
    // Each successful attempt still authenticates and decodes page one.
    const modes = hex ? (rawOnly ? ['raw'] : ['raw', 'pbkdf2-hex', 'pbkdf2-passphrase']) : (rawOnly ? [] : ['pbkdf2-passphrase'])
    for (const mode of modes) for (const profile of PROFILES) {
      if (size < profile.pageSize || size % profile.pageSize !== 0) continue
      const page = firstBytes.subarray(0, profile.pageSize)
      // Hex keys returned by WeChat may be the final encryption key or a KDF
      // input. Literal hex passphrases remain supported as a distinct attempt.
      const attempt = { input: mode === 'pbkdf2-passphrase' ? text : hex!, raw: mode === 'raw', name: mode }
      checkAbort(signal)
      const key = attempt.raw ? Buffer.from(attempt.input) : await derive(attempt.input, salt, profile.iterations, profile.digest, signal)
      let macKey: Buffer | undefined
      let matched = false
      try {
        macKey = await derive(key, macSalt, 2, profile.digest, signal)
        if (!verifyMac(page, 1, profile, macKey)) continue
        const clear = decryptPage(page, 1, profile, key, macKey)
        const valid = validHeader(clear, profile)
        clear.fill(0)
        if (!valid) continue
        matched = true
        return { profile, key, macKey, mode: attempt.name }
      } finally {
        if (!matched) { key.fill(0); macKey?.fill(0) }
      }
    }
    throw new SnapshotError('数据库密钥不匹配、第一页认证失败，或数据库加密格式暂不支持')
  } finally { hex?.fill(0); text.fill(0); macSalt.fill(0); firstBytes.fill(0) }
}

/** Authenticate a candidate against page 1 without making a plaintext snapshot. */
export async function verifyDatabaseKey(sourcePath: string, key: string, signal?: AbortSignal, options: { rawOnly?: boolean } = {}): Promise<boolean> {
  checkAbort(signal)
  const file = await open(sourcePath, 'r')
  try {
    const info = await file.stat()
    const header = await readExactly(file, Math.min(16, info.size), 0)
    if (header.equals(SQLITE_HEADER)) return key === ''
    let matched: MatchedCipher | undefined
    try { matched = await findCipher(file, info.size, key, signal, options.rawOnly); return true }
    catch (error) { checkAbort(signal); if (error instanceof SnapshotError) return false; throw error }
    finally { matched?.key.fill(0); matched?.macKey.fill(0) }
  } finally { await file.close() }
}

async function normalizeAndValidate(destination: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal)
  // The result is a standalone committed DB, never a new WAL-mode source.
  const file = await open(destination, 'r+')
  try { await writeExactly(file, Buffer.from([1, 1]), 18); await file.sync() } finally { await file.close() }
  const db = new DatabaseSync(destination, { readOnly: true, allowExtension: false, timeout: 1000 })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
    const checks = db.prepare('PRAGMA quick_check').all()
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new SnapshotError('数据库快照未通过 SQLite 完整性检查')
  } finally { db.close() }
  checkAbort(signal)
}

async function plaintextSnapshot(options: DatabaseSnapshotOptions, destination: string, stage: string): Promise<DatabaseSnapshotResult> {
  const { path: copy, stamps: copied } = await stableCopy(options, stage)
  const db = new DatabaseSync(copy, { readOnly: true, allowExtension: false, timeout: 1000 })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
    const row = db.prepare('PRAGMA page_size').get()
    const pageSize = Number(row && Object.values(row)[0])
    const pages = await backup(db, destination, { rate: 64, progress: ({ totalPages, remainingPages }) => report(options, (totalPages - remainingPages) * pageSize, totalPages * pageSize) })
    // Node does not call progress for a backup completed in its first batch.
    report(options, pages * pageSize, pages * pageSize)
  } finally { db.close() }
  await chmod(destination, 0o600)
  await normalizeAndValidate(destination, options.signal)
  return { encrypted: false, walApplied: Boolean(copied.wal && copied.wal.size > 32n), partial: false, warnings: [], format: 'SQLite3' }
}

type WalChecksum = [number, number]
function walChecksum(bytes: Buffer, previous: WalChecksum, littleEndian: boolean): WalChecksum {
  let [first, second] = previous
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const left = littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
    const right = littleEndian ? bytes.readUInt32LE(offset + 4) : bytes.readUInt32BE(offset + 4)
    first = (first + left + second) >>> 0
    second = (second + right + first) >>> 0
  }
  return [first, second]
}

interface WalPlan {
  pages: number
  basePages: number
  committedFrames: number
  latest: Map<number, number>
  warnings: string[]
  partial: boolean
}

async function* walBatches(wal: FileHandle, frameSize: number, frames: number, signal?: AbortSignal) {
  const batchFrames = Math.max(1, Math.floor(IO_BATCH_BYTES / frameSize))
  for (let first = 0; first < frames; first += batchFrames) {
    checkAbort(signal)
    const count = Math.min(batchFrames, frames - first)
    const bytes = await readExactly(wal, count * frameSize, 32 + first * frameSize)
    yield { first, count, bytes }
  }
}

/** Validate the SQLite WAL envelope over encrypted payloads before decoding.
 * SQLCipher encodes each page before SQLite computes its rolling checksum.
 * Keep offsets only for the latest committed version of each live page.
 * https://www.sqlite.org/fileformat2.html#walformat
 */
async function inspectWal(wal: FileHandle, size: number, pageSize: number, mainPages: number, signal?: AbortSignal): Promise<WalPlan> {
  const plan: WalPlan = { pages: mainPages, basePages: mainPages, committedFrames: 0, latest: new Map(), warnings: [], partial: false }
  if (!size) return plan
  if (size < 32) throw new SnapshotError('WAL 文件头已截断，无法读取完整快照')
  const header = await readExactly(wal, 32, 0)
  const magic = header.readUInt32BE(0)
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || header.readUInt32BE(4) !== 3007000 || header.readUInt32BE(8) !== pageSize) {
    throw new SnapshotError('WAL 文件头格式或页大小不匹配')
  }
  const littleEndian = magic === 0x377f0682
  let rolling = walChecksum(header.subarray(0, 24), [0, 0], littleEndian)
  if (header.readUInt32BE(24) !== rolling[0] || header.readUInt32BE(28) !== rolling[1]) throw new SnapshotError('WAL 文件头校验失败')
  const frameSize = pageSize + 24
  const lockPage = Math.floor(0x40000000 / pageSize) + 1
  const frames = Math.floor((size - 32) / frameSize)
  if (frames > 0xfffffffe) throw new SnapshotError('WAL 帧数超出读取范围')
  const pending = new Map<number, number>()
  for await (const batch of walBatches(wal, frameSize, frames, signal)) for (let local = 0; local < batch.count; local += 1) {
    const index = batch.first + local
    checkAbort(signal)
    const position = 32 + index * frameSize
    const frame = batch.bytes.subarray(local * frameSize, (local + 1) * frameSize)
    if (!frame.subarray(8, 16).equals(header.subarray(16, 24))) {
      // Reusing a WAL does not truncate its old tail. Frames from a previous
      // generation are not part of this transaction sequence. A new valid WAL
      // header can precede its very first frame, leaving ONLY old-generation
      // frames. SQLite then reads the checkpointed main DB, not a fatal error.
      // Still authenticate every used DB page and quick_check the private DB.
      // https://www.sqlite.org/fileformat2.html#walreset
      plan.warnings.push(plan.committedFrames
        ? '已忽略 WAL 中不属于当前代际的残留尾帧，读取当前代际已校验的提交'
        : 'WAL 当前代际尚无有效提交，已忽略旧代际残留帧并读取经认证与完整性检查的主库')
      return plan
    }
    const pageNumber = frame.readUInt32BE(0)
    const databasePages = frame.readUInt32BE(4)
    // SQLite skips the pending-byte page when growth crosses the 1 GiB mark.
    const maximumPages = Math.min(0xfffffffe, mainPages + frames + (mainPages < lockPage && mainPages + frames >= lockPage ? 1 : 0))
    if (!pageNumber || pageNumber === lockPage || pageNumber > maximumPages || databasePages > maximumPages) throw new SnapshotError('WAL 页号或提交大小超出有效范围')
    rolling = walChecksum(frame.subarray(0, 8), rolling, littleEndian)
    rolling = walChecksum(frame.subarray(24), rolling, littleEndian)
    if (frame.readUInt32BE(16) !== rolling[0] || frame.readUInt32BE(20) !== rolling[1]) {
      if (!plan.committedFrames) throw new SnapshotError('WAL 帧滚动校验失败，未找到可验证的提交')
      // Like SQLite recovery, stop at the first invalid frame. Never search
      // beyond a broken checksum chain or claim this prefix covers the tail.
      plan.warnings.push('WAL 尾部滚动校验失败，仅恢复此前最后一个有效提交；本次资料可能不完整')
      plan.partial = true
      return plan
    }
    pending.set(pageNumber, position + 24)
    if (databasePages) {
      for (const [number, offset] of pending) if (number <= databasePages) plan.latest.set(number, offset)
      for (const number of plan.latest.keys()) if (number > databasePages) plan.latest.delete(number)
      pending.clear()
      plan.pages = databasePages
      plan.basePages = Math.min(plan.basePages, databasePages)
      plan.committedFrames = index + 1
    }
  }
  if ((size - 32) % frameSize) {
    if (!plan.committedFrames) throw new SnapshotError('WAL 尾部帧已截断，未找到可验证的提交')
    plan.warnings.push('WAL 尾部帧已截断，仅恢复此前最后一个有效提交；本次资料可能不完整')
    plan.partial = true
  }
  return plan
}

async function encryptedSnapshot(options: DatabaseSnapshotOptions, destination: FileHandle, stage: string): Promise<DatabaseSnapshotResult> {
  const copied = await stableCopy(options, stage)
  const source = await open(copied.path, 'r')
  let wal: FileHandle | undefined
  let cipher: MatchedCipher | undefined
  let replayBuffer: Buffer | undefined
  const size = Number(copied.stamps.db.size)
  if (size < 100 || !Number.isSafeInteger(size)) { await source.close(); throw new SnapshotError('数据库副本为空、已截断或过大') }
  const keyText = /^[a-f\d]{64}$/i.test(options.key.trim()) ? options.key.trim() : options.key
  try {
    cipher = await findCipher(source, size, keyText, options.signal)
    const pages = size / cipher.profile.pageSize
    if (pages > 0xfffffffe) throw new SnapshotError('数据库页数超出当前读取器支持范围')
    let plan: WalPlan = { pages, basePages: pages, committedFrames: 0, latest: new Map(), warnings: [], partial: false }
    if (copied.stamps.wal?.size) {
      if (copied.stamps.wal.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SnapshotError('WAL 文件过大')
      wal = await open(`${copied.path}-wal`, 'r')
      plan = await inspectWal(wal, Number(copied.stamps.wal.size), cipher.profile.pageSize, pages, options.signal)
    }
    const pageSize = cipher.profile.pageSize
    const lockPage = Math.floor(0x40000000 / pageSize) + 1
    const total = size + plan.committedFrames * pageSize
    report(options, 0, total)
    const batchPages = Math.max(1, Math.floor(IO_BATCH_BYTES / pageSize))
    for (let first = 0; first < pages; first += batchPages) {
      checkAbort(options.signal)
      const count = Math.min(batchPages, pages - first, Math.max(0, plan.basePages - first))
      if (count) {
        const position = first * pageSize
        const encrypted = await readExactly(source, count * pageSize, position)
        const clearBatch = Buffer.alloc(encrypted.length)
        let hasData = false
        try {
          for (let local = 0; local < count; local += 1) {
            checkAbort(options.signal)
            const number = first + local + 1
            // The lock-byte page is not a SQLCipher page. Replaced WAL pages
            // remain zero here and are authenticated in the replay below.
            if (number === lockPage || plan.latest.has(number)) continue
            const page = encrypted.subarray(local * pageSize, (local + 1) * pageSize)
            const clear = decryptPage(page, number, cipher.profile, cipher.key, cipher.macKey)
            try { clear.copy(clearBatch, local * pageSize); hasData = true } finally { clear.fill(0) }
          }
          if (hasData) await writeExactly(destination, clearBatch, position)
        } finally { clearBatch.fill(0) }
      }
      report(options, Math.min(pages, first + batchPages) * pageSize, total)
    }
    // Growth after a truncating commit must be backed by WAL pages, rather than
    // reviving obsolete pages from the checkpointed main file.
    for (let number = plan.basePages + 1; number <= plan.pages; number += 1) {
      checkAbort(options.signal)
      if (number !== lockPage && !plan.latest.has(number)) throw new SnapshotError('WAL 提交缺少新增数据库页，无法生成完整快照')
    }
    const salt = await readExactly(source, SALT_SIZE, 0)
    let replayStart = 0, replayBytes = 0
    if (plan.committedFrames) replayBuffer = Buffer.alloc(IO_BATCH_BYTES)
    const flushReplay = async () => {
      if (!replayBytes) return
      await writeExactly(destination, replayBuffer!.subarray(0, replayBytes), replayStart)
      replayBuffer!.fill(0, 0, replayBytes)
      replayBytes = 0
    }
    if (wal) for await (const batch of walBatches(wal, pageSize + 24, plan.committedFrames, options.signal)) for (let local = 0; local < batch.count; local += 1) {
      const index = batch.first + local
      checkAbort(options.signal)
      const position = 32 + index * (pageSize + 24)
      const frame = batch.bytes.subarray(local * (pageSize + 24), (local + 1) * (pageSize + 24))
      const number = frame.readUInt32BE(0)
      const page = frame.subarray(24)
      if (number === 1 && !page.subarray(0, SALT_SIZE).equals(salt)) throw new SnapshotError('WAL 第一页加密盐值不匹配')
      let clear: Buffer
      try { clear = decryptPage(page, number, cipher.profile, cipher.key, cipher.macKey) }
      catch (error) { if (error instanceof SnapshotError) throw new SnapshotError(`WAL 第 ${number} 页认证失败，无法读取完整快照`); throw error }
      try {
        if (number === 1 && !validHeader(clear, cipher.profile)) throw new SnapshotError('WAL 第一页数据库格式无效')
        if (plan.latest.get(number) === position + 24) {
          const target = (number - 1) * pageSize
          if (replayBytes && (target !== replayStart + replayBytes || replayBytes + pageSize > replayBuffer!.length)) await flushReplay()
          if (!replayBytes) replayStart = target
          clear.copy(replayBuffer!, replayBytes)
          replayBytes += pageSize
        }
      } finally { clear.fill(0) }
      if (index === 0 || (index + 1) % 64 === 0 || index === plan.committedFrames - 1) report(options, size + (index + 1) * pageSize, total)
    }
    await flushReplay()
    await destination.truncate(plan.pages * pageSize)
    if (plan.committedFrames) {
      // WAL commit markers are authoritative for the final logical DB size.
      // Convert the private result to a standalone header before quick_check.
      const header = await readExactly(destination, 100, 0)
      header.writeUInt32BE(plan.pages, 28)
      header.copy(header, 92, 24, 28)
      await writeExactly(destination, header, 0)
    }
    await destination.sync()
    return { encrypted: true, walApplied: plan.committedFrames > 0, partial: plan.partial, warnings: plan.warnings, format: `${cipher.profile.name}-${pageSize}-${cipher.mode}` }
  } finally { replayBuffer?.fill(0); cipher?.key.fill(0); cipher?.macKey.fill(0); await wal?.close(); await source.close() }
}

/**
 * Produce a private, authenticated, standalone SQLite snapshot. Source files are
 * opened only with fs 'r'; SQLite is only allowed to touch our private copies.
 * The destination must not exist. No plaintext or key is retained on failure.
 * Encrypted WAL frames are authenticated and replayed through the last commit
 * on a stable private DB/WAL copy. Live files may continue changing afterwards.
 */
export async function createDatabaseSnapshot(options: DatabaseSnapshotOptions): Promise<DatabaseSnapshotResult> {
  checkAbort(options.signal)
  const sourcePath = resolve(options.sourcePath)
  const destinationPath = resolve(options.destinationPath)
  if (sourcePath === destinationPath) throw new SnapshotError('快照位置不能与原数据库相同')
  const opts = { ...options, sourcePath, destinationPath }
  let output: FileHandle | undefined
  let source: FileHandle | undefined
  let stage: string | undefined
  let ownsOutput = false
  let ownsSidecars = false
  let success = false
  try {
    const sourceInfo = await lstat(sourcePath)
    if (!sourceInfo.isFile() && !sourceInfo.isSymbolicLink()) throw new SnapshotError('所选数据库不是普通文件')
    const parent = await realpath(dirname(destinationPath))
    if (join(parent, basename(destinationPath)) === await realpath(sourcePath)) throw new SnapshotError('快照位置不能与原数据库相同')
    const before = await stamps(sourcePath)
    if (before.db.size < 100n || before.db.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SnapshotError('数据库为空、已截断或过大')
    source = await open(sourcePath, 'r')
    const header = await readExactly(source, 16, 0)
    output = await open(destinationPath, 'wx+', 0o600)
    ownsOutput = true
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        await lstat(`${destinationPath}${suffix}`)
        throw new SnapshotError('快照位置存在数据库附属文件，请使用新的目标位置')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    ownsSidecars = true
    report(opts, 0, Number(before.db.size))
    stage = await mkdtemp(join(parent, '.database-snapshot-'))
    await chmod(stage, 0o700)
    let result: DatabaseSnapshotResult
    if (header.equals(SQLITE_HEADER)) {
      await output.close(); output = undefined
      result = await plaintextSnapshot(opts, destinationPath, stage)
    } else {
      result = await encryptedSnapshot(opts, output, stage)
      await output.close(); output = undefined
      await normalizeAndValidate(destinationPath, opts.signal)
    }
    if (stage) { await rm(stage, { recursive: true, force: true }); stage = undefined }
    checkAbort(opts.signal)
    success = true
    return result
  } catch (error) {
    if (error instanceof SnapshotError || (error as Error).name === 'AbortError') throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SnapshotError('快照位置已存在文件，请使用新的目标位置')
    throw new SnapshotError('无法创建有效数据库快照；请检查文件权限、数据库格式及剩余空间')
  } finally {
    await source?.close().catch(() => {})
    await output?.close().catch(() => {})
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {})
    if (ownsOutput && !success) {
      for (const suffix of ownsSidecars ? ['', '-wal', '-shm', '-journal'] : ['']) await rm(`${destinationPath}${suffix}`, { force: true }).catch(() => {})
    }
  }
}
