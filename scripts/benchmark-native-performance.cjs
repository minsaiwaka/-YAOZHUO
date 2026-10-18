// Synthetic data only. Optional --baseline-dir compares an earlier source copy.
// node scripts/benchmark-native-performance.cjs --messages 30000 --snapshot-mib 24
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const count = Number(option('--messages', '30000'))
const mib = Number(option('--snapshot-mib', '24'))
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000 || !Number.isInteger(mib) || mib < 1 || mib > 256) throw new Error('Invalid synthetic fixture size')
const baselineDir = option('--baseline-dir')
const root = path.resolve(__dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaozhuo-performance-'))
const rawHex = '18396da7a223436d43c560e3cc62d57cf12ba129b1df5e179133506462d843f1'
const owner = 'wxid_synthetic_owner', peer = 'wxid_synthetic_peer'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

function load(filename) {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const isolated = new Module(filename, module)
  isolated.filename = filename
  isolated.paths = Module._nodeModulePaths(path.join(root, 'electron/caseboard'))
  isolated._compile(compiled, filename)
  return isolated.exports
}
function encrypt(input, reserve, hash) {
  const salt = crypto.randomBytes(16), key = Buffer.from(rawHex, 'hex')
  const macKey = crypto.pbkdf2Sync(key, Buffer.from([...salt].map(byte => byte ^ 0x3a)), 2, 32, hash)
  const output = Buffer.alloc(input.length), end = 4096 - reserve
  for (let offset = 0, number = 1; offset < input.length; offset += 4096, number++) {
    const skip = number === 1 ? 16 : 0, iv = crypto.randomBytes(16)
    const aes = crypto.createCipheriv('aes-256-cbc', key, iv); aes.setAutoPadding(false)
    const ciphertext = Buffer.concat([aes.update(input.subarray(offset + skip, offset + end)), aes.final()])
    if (number === 1) salt.copy(output)
    ciphertext.copy(output, offset + skip); iv.copy(output, offset + end)
    const pageId = Buffer.alloc(4); pageId.writeUInt32LE(number)
    crypto.createHmac(hash, macKey).update(ciphertext).update(iv).update(pageId).digest().copy(output, offset + end + 16)
  }
  key.fill(0); macKey.fill(0)
  return output
}
function reserveDatabase(filename, reserve) {
  let db = new DatabaseSync(filename); db.exec('PRAGMA page_size=4096; VACUUM;'); db.close()
  const bytes = fs.readFileSync(filename); bytes[20] = reserve; bytes.writeUInt16BE(4096 - reserve, 105); fs.writeFileSync(filename, bytes)
  return new DatabaseSync(filename)
}
async function main() {
  const messageFile = path.join(folder, 'messages.db')
  const db = new DatabaseSync(messageFile)
  db.exec('CREATE TABLE contact(username TEXT, nick_name TEXT); CREATE TABLE session(username TEXT); CREATE TABLE messages(local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER, create_time INTEGER, is_send INTEGER, session_id TEXT, message_content TEXT); BEGIN;')
  db.prepare('INSERT INTO contact VALUES(?,?)').run(peer, '合成測試人物')
  db.prepare('INSERT INTO session VALUES(?)').run(peer)
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < count; index++) insert.run(index + 1, 9223372036800000000n + BigInt(index), 1, 1756684800 + Math.floor(index / 4), index % 2, peer, `合成資料 ${index} ${'青綠色'.repeat(20)}`)
  db.exec('COMMIT;'); db.close()
  const largeFile = path.join(folder, 'large-plain.db')
  const large = reserveDatabase(largeFile, 80)
  large.exec('CREATE TABLE payload(id INTEGER PRIMARY KEY, data BLOB); BEGIN;')
  const put = large.prepare('INSERT INTO payload VALUES(?,?)'), payload = Buffer.alloc(3500, 7)
  const payloadRows = Math.ceil(mib * 1024 * 1024 / 3500)
  for (let index = 0; index < payloadRows; index++) put.run(index + 1, payload)
  large.exec('COMMIT;'); large.close()
  const sourcePath = path.join(folder, 'encrypted.db')
  fs.writeFileSync(sourcePath, encrypt(fs.readFileSync(largeFile), 80, 'sha512'))
  const smallFile = path.join(folder, 'wechat3-plain.db'), small = reserveDatabase(smallFile, 48)
  small.exec("CREATE TABLE payload(data TEXT); INSERT INTO payload VALUES('合成測試');"); small.close()
  const wechat3 = path.join(folder, 'wechat3-encrypted.db')
  fs.writeFileSync(wechat3, encrypt(fs.readFileSync(smallFile), 48, 'sha1'))
  const originalDigest = digest(fs.readFileSync(sourcePath))
  const variants = [...(baselineDir ? [{ label: 'baseline', dir: path.resolve(baselineDir) }] : []), { label: 'optimized', dir: path.join(root, 'electron/caseboard') }]
  const results = []
  for (const variant of variants) {
    const { NativeReader } = load(path.join(variant.dir, 'native-reader.ts'))
    const { createDatabaseSnapshot, verifyDatabaseKey } = load(path.join(variant.dir, 'database-crypto.ts'))
    const reader = new NativeReader([{ sourcePath: '/NEVER_READ_SYNTHETIC_SOURCE', snapshotPath: messageFile, kind: 'message', relativePath: 'messages.db' }], { ownerId: owner, ownerName: '合成使用者' })
    let began = performance.now()
    const dataset = await reader.load([peer], 0, new AbortController().signal, () => {})
    const readerMs = performance.now() - began
    assert.equal(dataset.messages.length, count)
    const messageDigest = digest(JSON.stringify(dataset.messages)); reader.close()
    let reads = 0, writes = 0
    const originalOpen = fsp.open
    fsp.open = async (...args) => {
      const handle = await originalOpen(...args), read = handle.read.bind(handle), write = handle.write.bind(handle)
      handle.read = async (...args) => { reads++; return read(...args) }
      handle.write = async (...args) => { writes++; return write(...args) }
      return handle
    }
    const destinationPath = path.join(folder, `snapshot-${variant.label}.db`)
    began = performance.now()
    try { await createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex }) }
    finally { fsp.open = originalOpen }
    const snapshotMs = performance.now() - began
    const snapshot = new DatabaseSync(destinationPath, { readOnly: true })
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM payload').get().n, payloadRows); snapshot.close()
    assert.equal(digest(fs.readFileSync(sourcePath)), originalDigest)
    began = performance.now()
    for (let index = 0; index < 8; index++) assert.equal(await verifyDatabaseKey(wechat3, rawHex), true)
    results.push({ variant: variant.label, messages: count, readerMs: Math.round(readerMs), messageDigest, encryptedMiB: +(fs.statSync(sourcePath).size / 1048576).toFixed(1), snapshotMs: Math.round(snapshotMs), reads, writes, wechat3Verify8Ms: Math.round(performance.now() - began) })
  }
  if (results.length > 1) assert.equal(results[0].messageDigest, results[1].messageDigest, 'Evidence must be byte-identical')
  process.stdout.write(JSON.stringify({ syntheticOnly: true, results }, null, 2) + '\n')
}
main().finally(() => fs.rmSync(folder, { recursive: true, force: true })).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
