import { parentPort, workerData } from 'node:worker_threads'
import { open, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createDatabaseSnapshot } from './database-crypto'
import { NativeReader, type NativeDatabaseFile } from './native-reader'
import { findSourceDatabases, isInside, type SourceDatabase } from './native-discovery'
import { LocalMediaReader } from './native-media'
import { autoConfigure } from './auto-key'
import type { CaseDataset, Evidence, LoadOptions, NativeOpenOptions, NativeAutoOptions } from '../../src/caseboard/types'

let reader: NativeReader | null = null
let media: LocalMediaReader | null = null
let account: NativeOpenOptions | null = null
let sources: SourceDatabase[] = []
let root = ''
let controller: AbortController | null = null
let busy = false
// Snapshot errors belong to the source file, not to the lifetime of a load.
// A later successful retry replaces that file's old WAL/IO failure warning.
const snapshotWarnings = new Map<string, string[]>()
const snapshotFailures = new Map<string, string>()
const partialSnapshots = new Set<string>()
const evidence = new Map<string, Evidence>()
const snapshots = new Map<string, NativeDatabaseFile>()
type Progress = { sessionsDone: number; sessionsTotal: number; messages: number; sessionName: string }
let latestProgress: Progress | undefined
let lastProgressAt = -Infinity
function progress(value: Progress): void {
  latestProgress = value
  if (performance.now() - lastProgressAt >= 120) flushProgress()
}
function flushProgress(): void {
  if (!latestProgress) return
  parentPort!.postMessage({ progress: latestProgress })
  latestProgress = undefined
  lastProgressAt = performance.now()
}

function checkAbort(): void { if (controller?.signal.aborted) throw new Error('已取消本机资料读取') }
function warnings(): string[] { return [...snapshotWarnings.values()].flat().concat([...snapshotFailures.values()]) }
function snapshotFailed(file: SourceDatabase, error: unknown): void {
  snapshotWarnings.delete(file.sourcePath)
  snapshotFailures.set(file.sourcePath, `${file.relativePath}：${error instanceof Error ? error.message : '无法准备数据库快照'}`)
}
async function snapshot(file: SourceDatabase, index: number): Promise<NativeDatabaseFile> {
  checkAbort()
  const existing = snapshots.get(file.sourcePath)
  if (existing) return existing
  if (!isInside(root, await realpath(file.sourcePath))) throw new Error('数据库路径已变化，请重新选择资料目录')
  const input = await open(file.sourcePath, 'r')
  const salt = Buffer.alloc(16)
  try { await input.read(salt, 0, 16, 0) } finally { await input.close() }
  const keys = account?.keys || {}
  const key = keys[file.relativePath] || keys[salt.toString('hex')] || keys[basename(file.sourcePath)] || account?.key || ''
  const snapshotPath = join(workerData.sessionRoot, `database-${index}.db`)
  const result = await createDatabaseSnapshot({ sourcePath: file.sourcePath, destinationPath: snapshotPath, key, signal: controller!.signal,
    onProgress: (done, total) => progress({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: `校验并解密 ${file.relativePath} · ${Math.min(100, Math.floor(done * 100 / Math.max(1, total)))}%` }),
  })
  if (result.warnings.length) snapshotWarnings.set(file.sourcePath, result.warnings.map(warning => `${file.relativePath}：${warning}`))
  else snapshotWarnings.delete(file.sourcePath)
  snapshotFailures.delete(file.sourcePath)
  if (result.partial) partialSnapshots.add(file.sourcePath)
  else partialSnapshots.delete(file.sourcePath)
  const prepared = { ...file, snapshotPath }
  snapshots.set(file.sourcePath, prepared)
  return prepared
}

parentPort!.on('message', async (request: { id: string; action: string; options?: unknown }) => {
  if (request.action === 'cancel') { controller?.abort(); return }
  if (busy) { parentPort!.postMessage({ id: request.id, error: '内置引擎正在处理上一项任务' }); return }
  busy = true
  controller = new AbortController()
  latestProgress = undefined
  lastProgressAt = -Infinity
  try {
    let result: unknown
    if (request.action === 'auto-setup') {
      result = await autoConfigure(request.options as NativeAutoOptions, { helperPath: workerData.keyHelperPath || '', documents: workerData.documents, cached: workerData.cached, profile: workerData.profile, profileOptions: workerData.profileOptions, signal: controller.signal, progress })
    } else if (request.action === 'open') {
      account = request.options as NativeOpenOptions
      const found = await findSourceDatabases(account.accountPath)
      root = found.root; sources = found.files
      const initial: NativeDatabaseFile[] = []
      const catalogFiles = sources.filter(value => value.kind !== 'message').length
      for (let index = 0; index < sources.length; index++) {
        const file = sources[index]
        if (file.kind === 'message') continue
        progress({ sessionsDone: initial.length, sessionsTotal: catalogFiles, messages: 0, sessionName: `准备 ${file.relativePath}` })
        try { initial.push(await snapshot(file, index)) }
        catch (error) { checkAbort(); snapshotFailed(file, error) }
      }
      if (!initial.some(file => file.kind === 'contact') || !initial.some(file => file.kind === 'session')) throw new Error(`联系人或会话数据库未能打开。${sources.filter(file => !initial.some(opened => opened.kind === file.kind) && file.kind !== 'message').flatMap(file => snapshotFailures.get(file.sourcePath) || []).join('；') || '请核对资料目录、密钥和微信版本。'}`)
      reader = new NativeReader(initial, { ownerId: account.ownerId, ownerName: account.ownerName })
      media = new LocalMediaReader(root, { imageKey: account.imageKey, xorKey: account.xorKey })
      const catalog = reader.catalog()
      if (!catalog.sessions.length) throw new Error('未识别到可读取的会话，请检查微信数据库版本或账号目录')
      result = { people: catalog.people, sessions: catalog.sessions, ownerId: account.ownerId, warnings: [...new Set([...warnings(), ...catalog.warnings])], databaseCount: sources.length }
    } else if (request.action === 'load') {
      if (!reader || !account) throw new Error('本机资料尚未打开，请先读取联系人和会话')
      const files: NativeDatabaseFile[] = []
      for (let index = 0; index < sources.length; index++) {
        const file = sources[index]
        if (file.kind !== 'message') continue
        // Reuse completed snapshots, but retry any failed shard on every load.
        // A single readable shard must not suppress retries for the others.
        if (!snapshots.has(file.sourcePath)) {
          progress({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: `校验并解密 ${file.relativePath}` })
        }
        try { files.push(await snapshot(file, index)) }
        catch (error) { checkAbort(); snapshotFailed(file, error) }
      }
      if (!files.length) throw new Error(`没有成功打开消息数据库。${[...snapshotFailures.values()].join('；')}`)
      reader.addMessageFiles(files)
      const options = request.options as LoadOptions
      const dataset: CaseDataset = await reader.load(options.sessionIds, options.maxMessages, controller.signal, progress)
      const currentWarnings = warnings()
      dataset.coverage.warnings = [...new Set([...currentWarnings, ...dataset.coverage.warnings])]
      dataset.coverage.partial ||= snapshotFailures.size > 0 || partialSnapshots.size > 0
      evidence.clear()
      for (const item of dataset.messages) evidence.set(item.id, item)
      result = dataset
    } else if (request.action === 'media') {
      const options = request.options as { evidence?: Evidence }
      const original = evidence.get(options.evidence?.id || '')
      if (!original || !media) throw new Error('请重新读取包含此图片的本机资料；导入文件不会自动取得本机文件权限')
      result = await media.read(original)
    } else throw new Error('未知的内置引擎操作')
    flushProgress()
    parentPort!.postMessage({ id: request.id, result })
  } catch (error) {
    let message = error instanceof Error ? error.message : '内置读取未能完成'
    for (const secret of [account?.key, account?.imageKey, ...Object.values(account?.keys || {})]) if (secret) message = message.split(secret).join('[已隐藏]')
    flushProgress()
    parentPort!.postMessage({ id: request.id, error: message.slice(0, 7000) })
  } finally { busy = false; controller = null }
})

process.once('exit', () => { controller?.abort(); reader?.close(); media?.close(); account = null; evidence.clear() })
