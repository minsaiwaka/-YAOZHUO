import { spawn } from 'node:child_process'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { discoverAccounts, findSourceDatabases, isInside, type SourceDatabase } from './native-discovery'
import { verifyDatabaseKey } from './database-crypto'
import { invokeWeFlowProvider } from './weflow-provider'
import { discoverImageKeys } from './image-keys'
import type { WeFlowProfileKeys, WeFlowProfileOptions } from './weflow-profile'
import type { NativeAutoOptions, NativeAutoResult, NativeOpenOptions } from '../../src/caseboard/types'

export interface KeyCandidate { key: string; salt?: string; database?: string }
export interface HelperResult { candidates: KeyCandidate[]; processes: number; denied: boolean; limited: boolean; identityMismatch?: boolean }
type Progress = { sessionsDone: number; sessionsTotal: number; messages: number; sessionName: string }
type Dependencies = {
  helperPath: string
  signal: AbortSignal
  progress: (progress: Progress) => void
  cached?: NativeOpenOptions
  documents?: string
  profile?: WeFlowProfileKeys
  profileOptions?: WeFlowProfileOptions
  /** Dependency injection is confined to source tests, never an IPC argument. */
  scan?: (salts: string[], signal: AbortSignal, progress: (message: string) => void) => Promise<HelperResult>
}
const HEX_KEY = /^[a-f\d]{64}$/i, HEX_SALT = /^[a-f\d]{32}$/i
const HEADER = Buffer.from('SQLite format 3\0')
function check(signal: AbortSignal): void { if (signal.aborted) throw new Error('自动识别已取消') }

/** Metadata only: distinguish a sandbox/other-user backend before memory access. */
async function diagnoseWechatUser(helperPath: string, signal: AbortSignal): Promise<{ processes: number; sameUserProcesses: number; differentUserProcesses: number; denied: boolean } | undefined> {
  check(signal)
  return new Promise((accept, reject) => {
    const child = spawn(helperPath, ['--diagnose'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let output = '', settled = false
    const finish = (result?: { processes: number; sameUserProcesses: number; differentUserProcesses: number; denied: boolean }, error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (!child.killed) child.kill()
      if (error) reject(error); else accept(result)
    }
    const abort = () => finish(undefined, new Error('自动识别已取消'))
    const timer = setTimeout(() => finish(), 5000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 16_384) finish() })
    child.stderr.on('data', () => {})
    child.on('error', () => finish())
    child.on('close', code => {
      if (signal.aborted) { abort(); return }
      try {
        const result = JSON.parse(output.trim())
        if (code === 0 && result.type === 'diagnostic' && ['processes', 'sameUserProcesses', 'differentUserProcesses'].every(name => Number.isSafeInteger(result[name]) && result[name] >= 0)) finish(result)
        else finish()
      } catch { finish() }
    })
    if (signal.aborted) abort()
  })
}

/** The bundled helper only reads same-user WeChat processes. No injected code or elevation. */
export async function scanWechatKeys(helperPath: string, salts: string[], signal: AbortSignal, progress: (message: string) => void): Promise<HelperResult> {
  check(signal)
  if (!helperPath) return { candidates: [], processes: 0, denied: false, limited: false }
  try { if (!(await stat(helperPath)).isFile()) throw new Error() } catch { throw new Error('内置密钥读取器缺失，请重新构建或安装新版应用') }
  if (process.platform === 'win32') {
    progress('正在检查微信与应用的运行账户…')
    const diagnostic = await diagnoseWechatUser(helperPath, signal)
    if (diagnostic && diagnostic.sameUserProcesses === 0) return { candidates: [], processes: diagnostic.processes, denied: diagnostic.denied || diagnostic.differentUserProcesses > 0, identityMismatch: diagnostic.differentUserProcesses > 0, limited: false }
  }
  return new Promise((accept, reject) => {
    const candidates: KeyCandidate[] = [], seen = new Set<string>()
    let buffered = '', bytes = 0, settled = false, result: Omit<HelperResult, 'candidates'> | null = null
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (!child.killed) child.kill()
      if (error) { candidates.length = 0; reject(error) }
      else accept({ candidates, processes: result?.processes || 0, denied: result?.denied || false, limited: result?.limited || false })
    }
    const abort = () => finish(new Error('自动识别已取消'))
    const timer = setTimeout(() => finish(new Error('自动识别超时；请保持微信登录后重试')), 70_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 2 * 1024 * 1024) { finish(new Error('密钥读取器输出超过限制')); return }
      buffered += chunk
      let boundary
      while ((boundary = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, boundary).trim(); buffered = buffered.slice(boundary + 1)
        let value
        try { value = JSON.parse(line) } catch { continue }
        if (value?.type === 'candidate' && typeof value.key === 'string' && HEX_KEY.test(value.key)) {
          const salt = typeof value.salt === 'string' && HEX_SALT.test(value.salt) ? value.salt.toLowerCase() : undefined
          const key = value.key.toLowerCase(), identity = `${key}:${salt || ''}`
          if (!seen.has(identity) && candidates.length < 512) { seen.add(identity); candidates.push({ key, ...(salt ? { salt } : {}) }) }
        } else if (value?.type === 'progress') progress('正在读取已登录微信的密钥候选…')
        else if (value?.type === 'complete') result = { processes: Number.isSafeInteger(value.processes) ? value.processes : 0, denied: value.denied === true, limited: value.limited === true }
      }
    })
    // Error output is deliberately drained, never logged or copied into a UI message.
    child.stderr.on('data', () => {})
    child.on('error', () => finish(new Error('内置密钥读取器无法启动；请检查系统是否允许运行本应用')))
    child.on('close', code => { if (signal.aborted) abort(); else if (code !== 0 || !result) finish(new Error('内置密钥读取未完成，请保持微信登录后重试')); else finish() })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ salts: [...new Set(salts.filter(value => HEX_SALT.test(value)))].slice(0, 160) }))
  })
}

async function localCandidates(root: string): Promise<KeyCandidate[]> {
  const result: KeyCandidate[] = []
  const visit = (value: unknown, name = '', depth = 0): void => {
    if (depth > 4 || result.length >= 512) return
    if (typeof value === 'string') {
      if (HEX_KEY.test(value)) result.push({ key: value.toLowerCase(), ...(HEX_SALT.test(name) ? { salt: name.toLowerCase() } : { database: name.replace(/\\/g, '/') }) })
      else if (/^[a-f\d]{96}$/i.test(value)) result.push({ key: value.slice(0, 64).toLowerCase(), salt: value.slice(64).toLowerCase() })
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      const raw = row.key ?? row.raw_key ?? row.enc_key
      if (typeof raw === 'string' && HEX_KEY.test(raw)) {
        const salt = typeof row.salt === 'string' && HEX_SALT.test(row.salt) ? row.salt.toLowerCase() : HEX_SALT.test(name) ? name.toLowerCase() : undefined
        result.push({ key: raw.toLowerCase(), ...(salt ? { salt } : { database: name.replace(/\\/g, '/') }) })
      } else for (const [key, item] of Object.entries(row).slice(0, 512)) visit(item, key, depth + 1)
    }
  }
  for (const name of ['all_keys.json', 'keys.json', 'key_info.json']) {
    try {
      const file = await realpath(join(root, name))
      if (!isInside(root, file) || (await stat(file)).size > 1024 * 1024) continue
      visit(JSON.parse(await readFile(file, 'utf8')))
    } catch { /* A key file is optional and never treated as code. */ }
  }
  return result
}

export async function autoConfigure(options: NativeAutoOptions, dependencies: Dependencies): Promise<NativeAutoResult> {
  const { signal } = dependencies
  check(signal)
  if (!options || (options.accountPath !== undefined && (typeof options.accountPath !== 'string' || options.accountPath.length > 4096))) throw new Error('账号目录参数无效')
  const discovery = await discoverAccounts({ documents: dependencies.documents, profileOptions: dependencies.profileOptions })
  const base = { accounts: discovery.accounts, warnings: [] as string[], verifiedDatabases: 0, totalDatabases: 0 }
  let accountPath = options.accountPath?.trim()
  if (!accountPath) {
    if (discovery.accounts.length > 1) return { ...base, status: 'select-account', message: '发现多个微信账号，请选择本次读取的账号。' }
    if (!discovery.accounts.length) return { ...base, status: 'not-found', message: '没有在常见位置发现账号，请选择微信账号目录后再次自动识别。' }
    accountPath = discovery.accounts[0].path
  }
  let found: Awaited<ReturnType<typeof findSourceDatabases>>
  try { found = await findSourceDatabases(accountPath) }
  catch (error) {
    const scoped = await discoverAccounts({ roots: [accountPath], includeDefaults: false })
    if (scoped.accounts.length) return { ...base, accounts: scoped.accounts, status: 'select-account', message: '这是微信数据根目录，请选择其下本次读取的账号。' }
    throw error
  }
  const { root, files } = found
  base.totalDatabases = files.length
  const notify = (message: string) => dependencies.progress({ sessionsDone: base.verifiedDatabases, sessionsTotal: files.length, messages: 0, sessionName: message })
  notify('识别微信账号与数据库…')
  const databases: { file: SourceDatabase; salt: string; plain: boolean }[] = []
  for (const file of files) {
    check(signal)
    const input = await open(file.sourcePath, 'r'), header = Buffer.alloc(16)
    try { await input.read(header, 0, 16, 0) } finally { await input.close() }
    databases.push({ file, salt: header.toString('hex'), plain: header.equals(HEADER) })
  }
  const encrypted = databases.filter(value => !value.plain)
  const verified = new Map<string, string>()
  for (const item of databases) if (item.plain) verified.set(item.file.relativePath, '')
  base.verifiedDatabases = verified.size
  const candidates = [...(dependencies.profile?.candidates || []), ...await localCandidates(root)]
  const profileKeys = new Set((dependencies.profile?.candidates || []).map(candidate => candidate.key))
  base.warnings.push(...(dependencies.profile?.warnings || []))
  const cached = dependencies.cached && dependencies.cached.accountPath === root ? dependencies.cached : undefined
  if (cached) {
    if (HEX_KEY.test(cached.key)) candidates.push({ key: cached.key })
    for (const [database, key] of Object.entries(cached.keys || {})) if (HEX_KEY.test(key)) candidates.push({ key, ...(HEX_SALT.test(database) ? { salt: database } : { database }) })
  }
  const dedupe = new Set<string>(), reusable = new Set<string>(), attempts = new Set<string>()
  const generic: KeyCandidate[] = []
  let exhausted = false
  let validationMilliseconds = 0
  const validate = async (candidate: KeyCandidate, rawOnly = false): Promise<void> => {
    check(signal)
    if (exhausted) return
    const named = candidate.database ? candidate.database.split('\\').join('/') : ''
    let targets = encrypted.filter(item => !verified.has(item.file.relativePath) && (candidate.salt ? candidate.salt === item.salt : named ? named === item.file.relativePath || named === basename(item.file.sourcePath) || named.endsWith(`/${item.file.relativePath}`) : true))
    // A master-key candidate is first authenticated against a small catalog DB.
    if (!rawOnly && !candidate.salt && !named && !reusable.has(candidate.key)) targets = targets.sort((a, b) => Number(a.file.kind === 'message') - Number(b.file.kind === 'message')).slice(0, 1)
    for (const item of targets) {
      check(signal)
      if (validationMilliseconds > 115_000) { exhausted = true; return }
      const attempt = `${candidate.key}:${item.file.relativePath}:${rawOnly ? 'raw' : 'all'}`
      if (attempts.has(attempt)) continue
      attempts.add(attempt)
      notify(`验证数据库密钥 · ${basename(item.file.sourcePath)}`)
      const began = Date.now()
      const valid = await verifyDatabaseKey(item.file.sourcePath, candidate.key, signal, { rawOnly })
      validationMilliseconds += Date.now() - began
      if (valid) {
        verified.set(item.file.relativePath, candidate.key); base.verifiedDatabases = verified.size; reusable.add(candidate.key)
      }
    }
  }
  const propagate = async (): Promise<void> => {
    // Authenticate common keys on each remaining shard before costly guesses.
    for (const key of reusable) if (verified.size < files.length && !exhausted) await validate({ key })
  }
  const retryGeneric = async (): Promise<void> => {
    let previous: number
    do {
      previous = verified.size
      await propagate()
      for (const candidate of generic.slice(0, 96)) {
        if (verified.size === files.length || exhausted) break
        if (!reusable.has(candidate.key)) await validate(candidate)
      }
      await propagate()
      // A later key may unlock the first catalog DB; retry earlier candidates
      // against the next unverified DB rather than losing reverse-ordered keys.
    } while (verified.size > previous && verified.size < files.length && !exhausted)
  }
  for (const candidate of candidates) {
    const id = `${candidate.key}:${candidate.salt || candidate.database || ''}`
    if (dedupe.has(id)) continue
    dedupe.add(id)
    if (candidate.salt || candidate.database) await validate(candidate)
    else { generic.push(candidate); await validate(candidate, true) }
  }
  await retryGeneric()
  if (verified.size < files.length && !exhausted && dependencies.profile?.providerPath) {
    notify('正在使用原版密钥组件协议获取密钥…')
    const provider = await invokeWeFlowProvider(dependencies.profile.providerPath, { action: 'get_db_key', dbPath: root, accountId: dependencies.profile.ownerId }, signal, notify)
    check(signal)
    if (provider.success && provider.key) {
      const candidate = { key: provider.key }
      generic.push(candidate); await validate(candidate, true); await retryGeneric()
    } else if (provider.error) base.warnings.push(provider.error)
  }
  let helper: HelperResult = { candidates: [], processes: 0, denied: false, limited: false }
  let scanFailed = false
  if (verified.size < files.length && !exhausted) {
    notify('请保持微信登录，正在自动获取密钥…')
    try {
      helper = await (dependencies.scan || ((salts, control, status) => scanWechatKeys(dependencies.helperPath, salts, control, status)))(encrypted.filter(value => !verified.has(value.file.relativePath)).map(value => value.salt), signal, notify)
    } catch {
      check(signal)
      scanFailed = true
      base.warnings.push('内置密钥扫描未能完成，已验证的连接信息仍保留；可重试尚未验证的分库。')
    }
    // Salt-addressed raw keys are quick to authenticate and are preferred.
    const ordered = [...helper.candidates].sort((a, b) => Number(!a.salt) - Number(!b.salt))
    for (const candidate of ordered) {
      const id = `${candidate.key}:${candidate.salt || ''}`
      if (dedupe.has(id)) continue
      dedupe.add(id)
      if (candidate.salt) await validate(candidate)
      else { generic.push(candidate); await validate(candidate, true) }
      if (verified.size === files.length) break
    }
    // Windows master secrets may require PBKDF2. Bound the costly candidate pass.
    await retryGeneric()
  }
  check(signal)
  if (exhausted) base.warnings.push('密钥验证达到了时间上限，请重新识别或在高级设置补充尚未验证的分库密钥。')
  if (helper.limited) base.warnings.push('微信内存扫描达到了时间或数据量上限，部分分库密钥可能尚未发现。')
  if (verified.size < files.length) base.warnings.push(`已验证 ${verified.size}/${files.length} 个数据库；未验证的分库不会填入猜测密钥。`)
  const folder = basename(root)
  const profileMatched = [...verified.values()].some(key => !!key && profileKeys.has(key))
  const ownerId = cached?.ownerId || (profileMatched ? dependencies.profile?.ownerId : '') || (/^[a-f\d]{32}$/i.test(folder) ? '' : /^wxid_.+_[a-z\d]{4}$/i.test(folder) ? folder.replace(/_[a-z\d]{4}$/i, '') : folder)
  const keys = Object.fromEntries([...verified].filter(([, key]) => key))
  const catalogKey = databases.find(item => item.file.kind === 'contact' && verified.has(item.file.relativePath))
  const key = catalogKey ? verified.get(catalogKey.file.relativePath)! : Object.values(keys)[0] || ''
  if (verified.size && (catalogKey || !encrypted.length)) {
    if (!ownerId) base.warnings.push('旧版账号目录使用哈希命名，请在高级设置补充本机微信 wxid。')
    notify('資料庫密鑰已驗證，正在獨立驗證本機圖片參數…')
    const images = await discoverImageKeys(root, [...(cached?.imageKey ? [{ imageKey: cached.imageKey, xorKey: cached.xorKey }] : []), ...(dependencies.profile?.mediaCandidates || [])], signal)
    if (images.encryptedSamples && !images.configuration) base.warnings.push('已找到加密圖片，但現有圖片參數未通過樣本驗證；資料庫連接可繼續，圖片參數可在高級設定補充。')
    if (images.limited) base.warnings.push('圖片參數自動驗證已達掃描上限；未驗證的參數不會自動填入。')
    return { ...base, status: verified.size === files.length ? 'ready' : 'partial', configuration: { accountPath: root, ownerId, ownerName: cached?.ownerName || '我', key, keys, ...(images.configuration || {}) }, message: `${profileMatched ? '已读取本机保存的连接设置并验证密钥' : encrypted.length ? '已自动获取并验证密钥' : '已识别未加密资料，无需密钥'}，已填充 ${verified.size}/${files.length} 个数据库。${images.configuration ? '圖片 AES 與 XOR 參數已用本機圖片獨立驗證並填入。' : '尚無可驗證的圖片參數；不影響讀取文字與聯絡人。'}` }
  }
  if (exhausted) return { ...base, status: 'not-found', message: '密钥验证已达到时间上限，尚未验证联系人数据库；请重新识别或使用高级设置。' }
  if (scanFailed) return { ...base, status: 'not-found', message: '内置密钥扫描未能完成，尚未取得可验证的联系人密钥。请从同一系统账户启动桌面版后重试，或使用已有密钥。' }
  if (helper.identityMismatch) return { ...base, status: 'permission', message: '当前读取服务与微信运行在不同的 Windows 用户下，无法读取此账号密钥。请从你的桌面启动新版謠诼，或双击“启动謠诼-Windows.cmd”后使用新打开的地址；托管网页预览不能代替你的登录账户。' }
  if (helper.denied) return { ...base, status: 'permission', message: process.platform === 'darwin' ? 'macOS 未允许读取微信进程密钥。系统保护可能阻止自动取钥；可使用已有密钥，应用不会修改微信签名或系统保护。' : '系统未允许读取当前微信进程，请确认微信和本应用由同一用户以普通权限启动。' }
  return { ...base, status: helper.processes ? 'not-found' : 'needs-wechat', message: helper.processes ? '未找到能通过数据库验证的密钥；当前微信版本可能尚未适配，可重新登录后重试或使用高级设置。' : '请先启动并登录微信，再点击自动识别。密钥仅在已登录微信的本机进程中读取。' }
}
