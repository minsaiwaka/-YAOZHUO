import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import type { NativeAccount, NativeDiscovery } from '../../src/caseboard/types'
import { discoverWeFlowRoots, type WeFlowProfileOptions } from './weflow-profile'

export interface SourceDatabase { sourcePath: string; relativePath: string; kind: 'contact' | 'session' | 'message' | 'group' }
const ignored = /^(?:node_modules|\.git|cache|temp|logs|filestorage|attachment|attach|video|image|image2|emoticon|emotion|fts|favorites|sns)$/i
function kindOf(path: string): SourceDatabase['kind'] | undefined {
  const name = basename(path).toLowerCase()
  if (/^(?:contact|wccontact_new\d*|micromsg)\.db$/.test(name)) return 'contact'
  if (/^(?:session|session_new|misc)\.db$/.test(name)) return 'session'
  if (/^(?:group|group_new|chatroom)\.db$/.test(name)) return 'group'
  if (/^(?:message(?:_\d+)?|msg(?:_?\d+)?)\.db$/.test(name)) return 'message'
  return undefined
}
export function isInside(root: string, file: string): boolean {
  const rel = relative(resolve(root), resolve(file))
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..')
}

/** Walk only the chosen account's database directories; never follow a symlink. */
export async function findSourceDatabases(accountPath: string): Promise<{ root: string; files: SourceDatabase[] }> {
  if (typeof accountPath !== 'string' || !accountPath.trim() || accountPath.length > 4096 || accountPath.includes('\0')) throw new Error('请选择微信账号资料目录')
  let root: string
  try { root = await realpath(accountPath.trim()); if (!(await stat(root)).isDirectory()) throw new Error() }
  catch { throw new Error('资料目录不存在或没有读取权限，请重新选择账号目录') }
  if (basename(root).toLowerCase() === 'db_storage') root = resolve(root, '..')
  const rootEntries = await readdir(root, { withFileTypes: true })
  const directoryNames = rootEntries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name.toLowerCase())
  const databaseStorage = rootEntries.find(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase() === 'db_storage')
  const directDatabase = rootEntries.some(entry => entry.isFile() && kindOf(entry.name))
  const legacyAccount = directoryNames.includes('msg') || (directoryNames.includes('contact') && directoryNames.includes('message') && directoryNames.includes('session'))
  if (!databaseStorage && !directDatabase && !legacyAccount) throw new Error('请选择单个微信账号目录，不能选择包含多个账号的父目录')
  const files: SourceDatabase[] = []
  let entriesSeen = 0
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { throw new Error('无法读取资料目录，请检查系统的文件访问权限') }
    for (const entry of entries) {
      if (++entriesSeen > 5000) throw new Error('此目录内容过多，请直接选择单个微信账号目录')
      if (entry.isSymbolicLink()) continue
      const file = join(directory, entry.name)
      if (entry.isDirectory() && entry.name.toLowerCase() === 'db_storage' && depth > 0) throw new Error('发现嵌套的微信账号目录，请直接选择单个账号，避免混合不同账号的记录')
      if (entry.isDirectory() && !ignored.test(entry.name)) await walk(file, depth + 1)
      else if (entry.isFile()) {
        const kind = kindOf(file)
        if (kind) files.push({ sourcePath: file, relativePath: relative(root, file).split(sep).join('/'), kind })
      }
    }
  }
  await walk(databaseStorage ? join(root, databaseStorage.name) : root, 0)
  if (!files.length) throw new Error('未找到受支持的微信数据库，请选择含 db_storage 的账号目录，或 macOS 3.x 账号目录')
  if (files.length > 160) throw new Error('检测到过多数据库，请选择单个账号目录')
  return { root, files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)) }
}

export async function discoverAccounts(options: { home?: string; documents?: string; platform?: string; roots?: string[]; includeDefaults?: boolean; profileOptions?: WeFlowProfileOptions } = {}): Promise<NativeDiscovery> {
  const home = options.home || homedir(), platform = options.platform || process.platform
  const documents = options.documents || join(home, 'Documents')
  const defaults = platform === 'darwin' ? [
    join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'),
    join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'),
    join(home, 'Library/Containers/com.tencent.WeChat/Data/Documents/xwechat_files'),
  ] : [join(documents, 'xwechat_files'), join(documents, 'WeChat Files'), join(home, 'xwechat_files'), join(home, 'OneDrive/Documents/xwechat_files')]
  const saved = options.includeDefaults === false ? [] : await discoverWeFlowRoots({ home, platform, ...options.profileOptions })
  const searched = [...new Set([...(options.roots || []), ...saved, ...(options.includeDefaults === false ? [] : defaults)])]
  const accounts: NativeAccount[] = []
  const seen = new Set<string>()
  const add = async (directory: string, children: string[]): Promise<boolean> => {
    const names = children.map(value => value.toLowerCase())
    if (!names.includes('db_storage') && !names.includes('msg') && !(names.includes('message') && names.includes('contact'))) return false
    try {
      const found = await findSourceDatabases(directory)
      // Like WeFlow's resolver, prefer actual databases over leftover folders.
      if (!found.files.some(file => file.kind === 'contact') || !found.files.some(file => file.kind === 'session')) return false
      const identity = platform === 'win32' ? found.root.toLowerCase() : found.root
      if (!seen.has(identity)) {
        seen.add(identity)
        accounts.push({ path: found.root, name: basename(found.root), version: names.includes('db_storage') ? '4.x' : '3.x' })
      }
      return true
    } catch { return false }
  }
  for (const directory of searched) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
    // A saved dbPath can already be an account directory.
    if (await add(directory, entries.map(entry => entry.name))) continue
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || /^(?:all users|applet|wmpf|backup|backupfiles|\.\.)$/i.test(entry.name)) continue
      const path = join(directory, entry.name)
      try {
        await add(path, await readdir(path))
      } catch { /* An unavailable account remains selectable by an explicit path. */ }
    }
  }
  return { accounts, searched, platform }
}
