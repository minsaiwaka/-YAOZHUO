// Publication check: prints file names and rule names, never matched secret values.
// Chat/database fixtures are generated locally by tests; no real archive is included.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const ignored = /^(?:node_modules|\.git|\.tmp|tmp|temp|caseboard-dist|dist-caseboard-electron|release-caseboard[^/]*|dist|release|coverage)(?:\/|$)/
const roots = new Set(['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README-WeFlow.md', 'CHANGELOG.md', 'examples/fictional-caseboard.json', '.gitignore', '.gitattributes', '.npmrc', 'caseboard.html', 'tsconfig.json', 'tsconfig.caseboard.json', 'vite.caseboard.config.ts', 'electron-builder.caseboard.cjs'])
const binaryAssets = new Set(['character-atlas.png', 'demo-book.png', 'demo-cat.png', 'demo-coffee.png', 'icon.png', 'fonts/BestTen-CRT.otf', 'fonts/BestTen-DOT.otf', 'fonts/ark-pixel-12px.woff2'])
const documentationImages = new Set(['01-board.jpg', '02-dossier.jpg', '03-statistics.jpg', '04-mentions.jpg', '05-avatars.jpg', '06-ai-scope.jpg'])
const personalTokens = [process.env.USERNAME, process.env.USER, os.hostname()].filter(value => value && value.length >= 4 && !/^(?:root|user|runner|localhost)$/i.test(value))
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const personalExpressions = personalTokens.map(value => new RegExp(`(?:^|[^a-z0-9_])${escape(value)}(?:$|[^a-z0-9_])`, 'i'))
let candidates = [], fromGit = false
try {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (fs.realpathSync(gitRoot) === fs.realpathSync(root)) {
    candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 5e6 }).toString().split('\0').filter(Boolean)
    fromGit = true
  }
} catch { /* A fresh publication folder intentionally has no old Git history. */ }
if (!fromGit) {
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name)
      if (ignored.test(file)) continue
      if (entry.isDirectory()) walk(file)
      else candidates.push(file)
    }
  }
  walk('')
}
const findings = [], inventory = []
const add = (file, rule, line) => { if (!findings.some(item => item.file === file && item.rule === rule && item.line === line)) findings.push({ file, rule, ...(line ? { line } : {}) }) }
const forbidden = /(?:^|\/)(?:\.caseboard-data|private|data|imports|exports|archives|backups|logs|work|outputs|screenshots|\.codex|\.agents|\.claude|\.vscode|\.idea)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|credentials\.json$|secrets\.json$|tokens\.json$|WeFlow-config\.json$|all_keys\.json$|image_keys?\.json$)|\.(?:db(?:-[\w-]+)?|sqlite(?:3)?(?:-[\w-]+)?|wal|shm|dat|log|pem|key|pfx|p12|p8|exe|dll|dmg|zip|7z|bak|local|blockmap)$/i
for (const file of [...new Set(candidates)].sort()) {
  const absolute = path.resolve(root, file)
  if (!absolute.startsWith(root + path.sep)) { add(file, 'outside-project'); continue }
  if (!fs.existsSync(absolute)) continue // Git may still list a deliberately removed file.
  const info = fs.lstatSync(absolute)
  if (!info.isFile() || info.isSymbolicLink()) { add(file, 'not-regular-file'); continue }
  if (forbidden.test(file) || ignored.test(file)) add(file, 'private-or-generated-file')
  if (!roots.has(file) && !/^(?:src\/caseboard|electron\/caseboard|native\/key-reader|public\/caseboard|scripts|docs|\.github\/workflows)\//.test(file)) add(file, 'unexpected-project-file')
  if (/^public\//.test(file) && !binaryAssets.has(file.slice('public/caseboard/'.length)) && !/^public\/caseboard\/fonts\/(?:OFL\.txt|README\.md)$/.test(file)) add(file, 'unexpected-public-asset')
  if (file.startsWith('docs/images/') && !documentationImages.has(file.slice('docs/images/'.length))) add(file, 'unexpected-documentation-image')
  const buffer = fs.readFileSync(absolute), text = buffer.toString('utf8'), unicode = buffer.toString('utf16le')
  inventory.push({ file, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') })
  if (info.size > 10 * 1024 * 1024) add(file, 'unexpected-large-file')
  if (personalExpressions.some(expression => expression.test(text) || expression.test(unicode))) add(file, 'local-user-or-host-identifier')
  if (/codex-clipboard-[\w-]+|S-1-5-21-\d+-\d+-\d+-\d+/i.test(text)) add(file, 'private-session-or-system-identifier')
  if (!/\.(?:ts|tsx|cjs|cs|m|css|json|md|txt|yml|yaml|html)$/.test(file) && !roots.has(file)) continue
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})/.test(line) || /^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) add(file, 'credential-format', index + 1)
    if (line.includes('@')) for (const match of line.matchAll(/[A-Z0-9._%+-]{1,100}@([A-Z0-9.-]{1,150}\.[A-Z]{2,})/gi)) if (!/^(?:example\.(?:test|com|org|net)|localhost)$/i.test(match[1])) add(file, 'email-address', index + 1)
    // Explicit fixture identities are portable unit-test examples, never account data.
    for (const match of line.matchAll(/(?:[A-Z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\s\\/"'<>]+)/gi)) if (!/^(?:fixture|example|test|runner|Public|Default|user|\$\{|\$\()/i.test(match[1])) add(file, 'personal-absolute-path', index + 1)
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const examplePath = path.join(root, 'examples/fictional-caseboard.json')
if (fs.existsSync(examplePath)) {
  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'))
  const fictionalIds = new Set(['me', 'lin', 'chen', 'xu', 'zhou', 'su', 'lu', 'g-town', 'g-photo', 'g-book'])
  if (example.source !== 'demo' || example.id !== 'readme-fictional-archive' || example.ownerId !== 'me' || example.messages?.length !== 120 || example.people?.length !== fictionalIds.size || example.people.some(person => !fictionalIds.has(person.id)) || example.messages.some(message => !/^demo-\d{3}$/.test(message.id) || !fictionalIds.has(message.senderId) || !fictionalIds.has(message.sessionId))) add('examples/fictional-caseboard.json', 'unexpected-example-data')
}
if (typeof pkg.author === 'object' || pkg.author !== 'Yaozhuo contributors') add('package.json', 'personal-package-author')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
for (const entry of Object.values(lock.packages || {})) if (entry.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) add('package-lock.json', 'non-public-dependency-source')
const report = { status: findings.length ? 'failed' : 'passed', version: pkg.version, files: inventory.length, bytes: inventory.reduce((sum, item) => sum + item.bytes, 0), scope: fromGit ? 'git-candidates' : 'standalone-source', findings }
console.log(JSON.stringify(report, null, 2))
if (process.argv.includes('--manifest')) { fs.mkdirSync(path.join(root, '.tmp'), { recursive: true }); fs.writeFileSync(path.join(root, '.tmp/publication-manifest.json'), JSON.stringify(inventory, null, 2)) }
process.exitCode = findings.length ? 1 : 0
