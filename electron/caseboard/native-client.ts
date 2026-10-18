import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { discoverAccounts, findSourceDatabases, isInside } from './native-discovery'
import { loadWeFlowKeys, type WeFlowProfileKeys, type WeFlowProfileOptions } from './weflow-profile'
import type { CaseDataset, ConnectionOptions, Evidence, LoadOptions, NativeCatalog, NativeOpenOptions, NativeAutoOptions, NativeAutoResult } from '../../src/caseboard/types'

type Progress = { sessionsDone: number; sessionsTotal: number; messages: number; sessionName: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (value: Progress) => void; cleanup: () => void }
type Connection = { worker: Worker; sessionRoot: string; pending: Map<string, Pending>; clientId?: string }
type AutoJob = { control: AbortController; done: Promise<unknown>; connection?: Connection }

function validateOpen(value: NativeOpenOptions): NativeOpenOptions {
  if (!value || typeof value.accountPath !== 'string' || value.accountPath.length > 4096) throw new Error('请选择微信账号资料目录')
  if (typeof value.ownerId !== 'string' || !/^[\w.@-]{1,256}$/.test(value.ownerId)) throw new Error('请填写此账号的微信 ID，用于区分本人和他人的消息')
  if (typeof value.ownerName !== 'string' || !value.ownerName.trim() || value.ownerName.length > 200) throw new Error('请填写当前账号的显示名')
  if (typeof value.key !== 'string' || (value.key !== '' && !/^[\da-f]{64}$/i.test(value.key))) throw new Error('数据库密钥应为 64 位十六进制；未加密数据库可留空')
  if (value.keys !== undefined && (!value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys) || Object.keys(value.keys).length > 160 || Object.entries(value.keys).some(([name, key]) => name.length > 1024 || typeof key !== 'string' || !/^[\da-f]{64}$/i.test(key)))) throw new Error('分库密钥须为“相对数据库路径或 salt: 64 位十六进制密钥”的 JSON 对象')
  if (value.imageKey !== undefined && value.imageKey !== '' && !/^(?:[\da-f]{32}|[\x20-\x7e]{16})$/i.test(value.imageKey)) throw new Error('图片 AES 密钥应为 16 位 ASCII 字符或 32 位十六进制')
  if (value.xorKey !== undefined && (!Number.isInteger(value.xorKey) || value.xorKey < 0 || value.xorKey > 255)) throw new Error('图片 XOR 参数应为 0–255 的整数')
  if (value.clientId !== undefined && (typeof value.clientId !== 'string' || !/^[\w-]{1,100}$/.test(value.clientId))) throw new Error('页面资料会话标识无效，请刷新后重试')
  return { accountPath: value.accountPath.trim(), key: value.key, keys: value.keys, ownerId: value.ownerId, ownerName: value.ownerName.trim(), imageKey: value.imageKey, xorKey: value.xorKey, clientId: value.clientId }
}

/** Database reads stay in bundled workers, owned by an opaque memory-only connection. */
export class NativeArchiveService {
  private connections = new Map<string, Connection>()
  private root: string
  private autoCache = new Map<string, NativeOpenOptions>()
  private autoJobs = new Set<AutoJob>()
  private disposed = false
  constructor(private options: { workerPath: string; dataRoot: string; documents?: string; keyHelperPath?: string; profileOptions?: WeFlowProfileOptions; decryptProtected?: (ciphertext: Buffer) => string | Promise<string> }) { this.root = resolve(options.dataRoot, 'native-snapshots') }
  discover() { return discoverAccounts({ documents: this.options.documents, profileOptions: this.options.profileOptions }) }
  async autoSetup(options: NativeAutoOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<NativeAutoResult> {
    if (!options || (options.accountPath !== undefined && (typeof options.accountPath !== 'string' || options.accountPath.length > 4096))) throw new Error('账号目录参数无效')
    if (signal.aborted) throw new Error('自动识别已取消')
    if (this.disposed) throw new Error('本机资料服务已关闭')
    const control = new AbortController(), abort = () => control.abort()
    signal.addEventListener('abort', abort, { once: true })
    const job: AutoJob = { control, done: Promise.resolve() }
    this.autoJobs.add(job)
    job.done = this.runAutoSetup(options, control.signal, progress, job)
    try { return await job.done as NativeAutoResult }
    finally { signal.removeEventListener('abort', abort); this.autoJobs.delete(job) }
  }
  private async runAutoSetup(options: NativeAutoOptions, signal: AbortSignal, progress: (value: Progress) => void, job: AutoJob): Promise<NativeAutoResult> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const sessionRoot = await mkdtemp(join(this.root, 'auto-'))
    let canonical = options.accountPath
    if (!canonical) {
      const discovered = await this.discover()
      if (discovered.accounts.length === 1) canonical = discovered.accounts[0].path
    }
    try { if (canonical) canonical = (await findSourceDatabases(canonical)).root } catch { /* The worker reports the directory error. */ }
    const cached = canonical ? this.autoCache.get(canonical) : this.autoCache.size === 1 ? [...this.autoCache.values()][0] : undefined
    let worker: Worker
    try {
      if (signal.aborted) throw new Error('自动识别已取消')
      let profile: WeFlowProfileKeys | undefined
      if (canonical) {
        progress({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: '读取本机已有连接设置，核对所选微信账号…' })
        profile = await loadWeFlowKeys(canonical, { ...this.options.profileOptions, signal, keyHelperPath: this.options.keyHelperPath, decryptProtected: this.options.decryptProtected })
      }
      if (signal.aborted) throw new Error('自动识别已取消')
      worker = new Worker(this.options.workerPath, { workerData: { sessionRoot, keyHelperPath: this.options.keyHelperPath, documents: this.options.documents, cached, profile, profileOptions: this.options.profileOptions } })
    } catch { await rm(sessionRoot, { recursive: true, force: true }); throw new Error(signal.aborted ? '自动识别已取消' : '内置自动识别引擎未能启动，请重新构建应用') }
    const connection: Connection = { worker, sessionRoot, pending: new Map() }
    job.connection = connection
    const failed = () => { for (const pending of connection.pending.values()) { pending.cleanup(); pending.reject(new Error('自动识别进程已停止，请重试')) }; connection.pending.clear() }
    worker.on('message', message => {
      if (message.progress) { for (const pending of connection.pending.values()) pending.progress?.(message.progress); return }
      const pending = connection.pending.get(message.id)
      if (!pending) return
      connection.pending.delete(message.id); pending.cleanup()
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result)
    })
    worker.once('error', failed); worker.once('exit', failed)
    try {
      const result = await this.call(connection, 'auto-setup', { accountPath: canonical || options.accountPath }, signal, progress) as NativeAutoResult
      if (result.configuration && !this.disposed) this.autoCache.set(result.configuration.accountPath, result.configuration)
      return result
    } finally { await worker.terminate(); if (isInside(this.root, sessionRoot)) await rm(sessionRoot, { recursive: true, force: true, maxRetries: 3 }) }
  }
  private connection(value: ConnectionOptions): Connection {
    if (!value || typeof value.connectionId !== 'string') throw new Error('请先打开本机微信资料')
    const connection = this.connections.get(value.connectionId)
    if (!connection) throw new Error('本机资料连接已关闭，请重新读取资料目录')
    return connection
  }
  private call(connection: Connection, action: string, options: unknown, signal?: AbortSignal, progress?: (value: Progress) => void): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('已取消本机资料读取'))
    if (connection.pending.size) return Promise.reject(new Error('内置引擎正在处理上一项任务'))
    return new Promise((resolveValue, reject) => {
      const id = randomUUID()
      const abort = () => connection.worker.postMessage({ action: 'cancel' })
      signal?.addEventListener('abort', abort, { once: true })
      connection.pending.set(id, { resolve: resolveValue, reject, progress, cleanup: () => signal?.removeEventListener('abort', abort) })
      connection.worker.postMessage({ id, action, options })
    })
  }
  async open(value: NativeOpenOptions, signal?: AbortSignal, progress?: (value: Progress) => void): Promise<NativeCatalog> {
    if (this.disposed) throw new Error('本机资料服务已关闭')
    const options = validateOpen(value)
    options.accountPath = (await findSourceDatabases(options.accountPath)).root
    // Reloads reuse the tab identifier, reclaiming that page's orphaned worker.
    if (options.clientId) for (const [connectionId, connection] of this.connections) if (connection.clientId === options.clientId) await this.close({ connectionId })
    if (this.connections.size >= 2) throw new Error('请先关闭已有资料连接，再打开其他账号')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const sessionRoot = await mkdtemp(join(this.root, 'account-'))
    let worker: Worker
    try { worker = new Worker(this.options.workerPath, { workerData: { sessionRoot } }) }
    catch { await rm(sessionRoot, { recursive: true, force: true }); throw new Error('内置读取引擎未能启动，请重新构建或安装应用') }
    const connection: Connection = { worker, sessionRoot, pending: new Map(), clientId: options.clientId }
    const connectionId = randomUUID()
    this.connections.set(connectionId, connection)
    worker.on('message', message => {
      if (message.progress) { for (const pending of connection.pending.values()) pending.progress?.(message.progress); return }
      const pending = connection.pending.get(message.id)
      if (!pending) return
      connection.pending.delete(message.id); pending.cleanup()
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    const crashed = () => {
      for (const pending of connection.pending.values()) { pending.cleanup(); pending.reject(new Error('内置读取进程已停止，请重新打开资料')) }
      connection.pending.clear()
      if (this.connections.get(connectionId) === connection) void this.close({ connectionId })
    }
    worker.once('error', crashed)
    worker.once('exit', crashed)
    try { const result = { ...(await this.call(connection, 'open', options, signal, progress) as Omit<NativeCatalog, 'connectionId'>), connectionId }; this.autoCache.set(options.accountPath, options); return result }
    catch (error) { await this.close({ connectionId }); throw error }
  }
  async load(value: LoadOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<CaseDataset> {
    if (!value || !Array.isArray(value.sessionIds) || !value.sessionIds.length || value.sessionIds.length > 30000 || value.sessionIds.some(id => typeof id !== 'string' || id.length > 512) || !Number.isSafeInteger(value.maxMessages) || value.maxMessages < 0 || value.maxMessages > 10_000_000) throw new Error('请选择会话与有效的消息数量范围')
    return await this.call(this.connection(value), 'load', { sessionIds: [...new Set(value.sessionIds)], maxMessages: value.maxMessages }, signal, progress) as CaseDataset
  }
  async media(value: ConnectionOptions & { evidence: Evidence }): Promise<{ dataUrl: string }> {
    if (!value?.evidence || typeof value.evidence.id !== 'string' || value.evidence.id.length > 2048) throw new Error('请选择带来源的图片消息')
    return await this.call(this.connection(value), 'media', { evidence: { id: value.evidence.id } }) as { dataUrl: string }
  }
  async close(value: ConnectionOptions): Promise<void> {
    const connection = this.connections.get(value?.connectionId)
    if (!connection) return
    this.connections.delete(value.connectionId)
    for (const pending of connection.pending.values()) { pending.cleanup(); pending.reject(new Error('本机资料连接已关闭')) }
    connection.pending.clear()
    await connection.worker.terminate()
    if (isInside(this.root, connection.sessionRoot) && connection.sessionRoot !== this.root) await rm(connection.sessionRoot, { recursive: true, force: true, maxRetries: 3 })
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.autoCache.clear()
    const jobs = [...this.autoJobs]
    for (const job of jobs) job.control.abort()
    // Give the worker time to stop its helper, then terminate any stalled worker.
    const timer = setTimeout(() => { for (const job of jobs) if (job.connection) void job.connection.worker.terminate() }, 2500)
    try { await Promise.allSettled([...jobs.map(job => job.done), ...[...this.connections.keys()].map(connectionId => this.close({ connectionId }))]) }
    finally { clearTimeout(timer); this.autoCache.clear() }
  }
}
