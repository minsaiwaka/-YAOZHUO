import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Compatibility with saved local settings, without starting or modifying WeFlow. */
export interface WeFlowProfileOptions {
  home?: string
  appData?: string
  platform?: string
  /** Source-test injection only; never accepted from an IPC request. */
  configPaths?: string[]
}
export interface WeFlowKeyCandidate { key: string; database?: string; salt?: string }
export interface WeFlowProfileKeys { candidates: WeFlowKeyCandidate[]; mediaCandidates?: { imageKey: string; xorKey?: number }[]; ownerId?: string; providerPath?: string; warnings: string[] }
export interface WeFlowKeyOptions extends WeFlowProfileOptions {
  signal: AbortSignal
  keyHelperPath?: string
  /** Electron safeStorage, supplied by the main process when available. */
  decryptProtected?: (ciphertext: Buffer) => string | Promise<string>
  /** Source-test injection only. The production helper always uses a fixed path. */
  storageKeyProvider?: (signal: AbortSignal) => Promise<Buffer>
}
type Profile = { filename: string; value: Record<string, unknown>; dbPath: string }
const HEX_KEY = /^[a-f\d]{64}$/i
const MAX_PROFILE_BYTES = 2 * 1024 * 1024

function check(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('自动识别已取消'); error.name = 'AbortError'; throw error }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function accountMatches(value: string, folder: string): boolean {
  const id = value.trim().toLowerCase(), directory = folder.toLowerCase()
  return id === directory || (directory.startsWith(`${id}_`) && /^[a-z\d]{4}$/i.test(directory.slice(id.length + 1)))
}
function accountId(value: string, folder: string): string {
  // An explicit wxid may itself end in four characters; strip a suffix only
  // from an ID that is the complete suffixed directory name.
  return value.trim().toLowerCase() === folder.toLowerCase() ? value.trim().replace(/_[a-z\d]{4}$/i, '') : value.trim()
}
function inside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function paths(options: WeFlowProfileOptions): string[] {
  if (options.configPaths) return options.configPaths.filter(value => typeof value === 'string' && value.length <= 4096).slice(0, 16)
  const home = options.home || homedir(), platform = options.platform || process.platform
  const appData = options.appData || (platform === 'win32' ? process.env.APPDATA || join(home, 'AppData/Roaming') : platform === 'darwin' ? join(home, 'Library/Application Support') : join(home, '.config'))
  return [...new Set(['WeFlow', 'weflow'].map(name => join(appData, name, 'WeFlow-config.json')))]
}
async function profiles(options: WeFlowProfileOptions, signal?: AbortSignal): Promise<Profile[]> {
  const result: Profile[] = []
  const seen = new Set<string>()
  for (const filename of paths(options)) {
    check(signal)
    try {
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROFILE_BYTES) continue
      const canonical = await realpath(filename)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const handle = await open(canonical, 'r')
      const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1)
      let length = 0
      try {
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (length > MAX_PROFILE_BYTES) continue
        const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''))
        if (!object(value) || typeof value.dbPath !== 'string' || !value.dbPath.trim() || value.dbPath.length > 4096) continue
        const home = options.home || homedir()
        const dbPath = value.dbPath.trim().replace(/^~(?=[\\/]|$)/, home)
        if (!isAbsolute(dbPath) || dbPath.includes('\0')) continue
        result.push({ filename: canonical, value, dbPath: resolve(dbPath) })
      } finally { bytes.fill(0); await handle.close() }
    } catch { check(signal) /* A missing/malformed saved profile is optional. */ }
  }
  return result
}

/** Reads only dbPath; it never decrypts settings or invokes a helper. */
export async function discoverWeFlowRoots(options: WeFlowProfileOptions = {}): Promise<string[]> {
  return [...new Set((await profiles(options)).map(profile => profile.dbPath))]
}

/** Fixed helper mode: no file path or arbitrary DPAPI ciphertext is accepted. */
async function readWindowsStorageKey(helperPath: string | undefined, signal: AbortSignal): Promise<Buffer> {
  check(signal)
  if (!helperPath) throw new Error('已保存设置解密组件不可用')
  return new Promise((accept, reject) => {
    const child = spawn(helperPath, ['--weflow-profile-key'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', bytes = 0, settled = false
    const finish = (error?: Error, key?: Buffer) => {
      if (settled) { key?.fill(0); return }
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (!child.killed) child.kill()
      output = ''
      if (error) { key?.fill(0); reject(error) } else accept(key!)
    }
    const abort = () => { const error = new Error('自动识别已取消'); error.name = 'AbortError'; finish(error) }
    const timer = setTimeout(() => finish(new Error('已保存设置解密超时')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 4096) { finish(new Error('已保存设置解密响应无效')); return }
      output += chunk
    })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(new Error('已保存设置解密组件无法启动')))
    child.on('close', code => {
      if (settled) return
      if (signal.aborted) { abort(); return }
      try {
        const result: unknown = JSON.parse(output.trim())
        if (code !== 0 || !object(result) || result.type !== 'storage-key' || typeof result.key !== 'string' || !/^[A-Za-z\d+/]{43}=$/.test(result.key)) throw new Error()
        const key = Buffer.from(result.key, 'base64')
        if (key.length !== 32) { key.fill(0); throw new Error() }
        finish(undefined, key)
      } catch { finish(new Error('无法解开 WeFlow 已保存设置；可继续自动扫描或手动填写密钥')) }
    })
    if (signal.aborted) abort()
  })
}

/**
 * Called only after the user requests automatic setup. Candidate secrets stay
 * in memory, and are returned only for the chosen account's configured root.
 */
export async function loadWeFlowKeys(accountRoot: string, options: WeFlowKeyOptions): Promise<WeFlowProfileKeys> {
  check(options.signal)
  const result: WeFlowProfileKeys = { candidates: [], warnings: [] }
  let root: string
  try { root = await realpath(accountRoot) } catch { check(options.signal); return result }
  const folder = basename(root), platform = options.platform || process.platform
  let storageKey: Buffer | undefined
  let storageAttempted = false
  const warnings = new Set<string>(), seen = new Set<string>()
  const decode = async (stored: unknown, accept = (text: string) => HEX_KEY.test(text)): Promise<string | undefined> => {
    check(options.signal)
    if (typeof stored !== 'string' || stored.length > 16_384) return
    if (stored.startsWith('lock:')) { warnings.add('WeFlow 已保存密钥受独立密码保护，请在原应用解锁后导出密钥，或使用自动扫描。'); return }
    if (!stored.startsWith('safe:')) return accept(stored) ? stored : undefined
    let ciphertext: Buffer | undefined, plaintext: Buffer | undefined, partial: Buffer | undefined
    try {
      const encoded = stored.slice(5)
      if (!encoded || !/^[A-Za-z\d+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error()
      ciphertext = Buffer.from(encoded, 'base64')
      let decoded: string | undefined
      if (platform === 'win32' && ciphertext.subarray(0, 3).toString('ascii') === 'v10') {
        if (!storageAttempted) {
          storageAttempted = true
          storageKey = await (options.storageKeyProvider || ((signal: AbortSignal) => readWindowsStorageKey(options.keyHelperPath, signal)))(options.signal)
          if (storageKey.length !== 32) { storageKey.fill(0); storageKey = undefined; throw new Error() }
        }
        if (!storageKey || ciphertext.length < 31) throw new Error()
        const decipher = createDecipheriv('aes-256-gcm', storageKey, ciphertext.subarray(3, 15))
        decipher.setAuthTag(ciphertext.subarray(-16))
        partial = decipher.update(ciphertext.subarray(15, -16))
        plaintext = Buffer.concat([partial, decipher.final()])
        decoded = plaintext.toString('utf8')
      } else if (options.decryptProtected) decoded = await options.decryptProtected(ciphertext)
      if (decoded === undefined || !accept(decoded)) throw new Error()
      check(options.signal)
      return decoded
    } catch {
      check(options.signal)
      warnings.add('WeFlow 已保存密钥未能解开，将继续使用自动扫描或高级设置。')
    } finally { ciphertext?.fill(0); plaintext?.fill(0); partial?.fill(0) }
  }
  const add = async (stored: unknown): Promise<void> => {
    const key = (await decode(stored))?.toLowerCase()
    if (key && !seen.has(key)) { seen.add(key); result.candidates.push({ key }) }
  }
  const addMedia = async (config: Record<string, unknown>): Promise<void> => {
    const imageKey = await decode(config.imageAesKey ?? config.imageKey, text => /^[a-f\d]{32}$/i.test(text) || /^[\x20-\x7e]{16}$/.test(text))
    if (!imageKey) return
    const xor = config.imageXorKey ?? config.xorKey
    const decoded = await decode(typeof xor === 'number' ? String(xor) : xor, text => /^\d{1,3}$/.test(text) && Number(text) <= 255)
    const candidate = { imageKey, ...(decoded !== undefined ? { xorKey: Number(decoded) } : {}) }
    result.mediaCandidates ||= []
    if (!result.mediaCandidates.some(value => value.imageKey === imageKey && value.xorKey === candidate.xorKey)) result.mediaCandidates.push(candidate)
  }
  try {
    for (const profile of await profiles(options, options.signal)) {
      check(options.signal)
      let dbRoot: string
      try { dbRoot = await realpath(profile.dbPath) } catch { continue }
      if (!inside(dbRoot, root)) continue
      const value = profile.value
      if (!result.providerPath && typeof value.keyProviderPath === 'string' && value.keyProviderPath.length <= 4096 && !value.keyProviderPath.includes('\0') && isAbsolute(value.keyProviderPath)) {
        try {
          const provider = await realpath(value.keyProviderPath)
          if ((await lstat(provider)).isFile()) result.providerPath = provider
        } catch { /* A missing provider must not block saved-key restoration. */ }
      }
      const ownerFields = ['myAccountId', 'myWxid', 'myWxId', 'wxid', 'currentAccountId', 'accountId']
      const owner = ownerFields.map(name => value[name]).find(item => typeof item === 'string' && item.trim()) as string | undefined
      const ownerMatches = !owner || accountMatches(owner, folder)
      const accounts = object(value.accountConfigs) ? value.accountConfigs : {}
      for (const [id, config] of Object.entries(accounts).slice(0, 200)) {
        if (!object(config) || !accountMatches(id, folder)) continue
        result.ownerId ||= accountId(id, folder)
        await add(config.decryptKey ?? config.dbKey ?? config.databaseKey)
        await addMedia(config)
      }
      if (ownerMatches) {
        if (owner) result.ownerId ||= accountId(owner, folder)
        await add(value.decryptKey ?? value.dbKey ?? value.databaseKey)
        if (owner || dbRoot === root) await addMedia(value)
      }
    }
    check(options.signal)
    result.warnings = [...warnings]
    return result
  } finally { storageKey?.fill(0) }
}
