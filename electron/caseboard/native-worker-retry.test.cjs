// Real worker regression tests. All databases, keys and WAL blockers are
// synthetic and created under this project's private tmp directory.
// node --test electron/caseboard/native-worker-retry.test.cjs
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')

const tmpRoot = path.resolve(__dirname, '../../.caseboard-data/tmp')
fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
const suiteRoot = fs.mkdtempSync(path.join(tmpRoot, 'native-wal-retry-'))
const compiled = path.join(suiteRoot, 'compiled')
fs.mkdirSync(compiled, { mode: 0o700 })
for (const name of ['native-client', 'native-worker', 'native-reader', 'database-crypto', 'native-discovery', 'native-media', 'auto-key', 'image-keys', 'weflow-profile', 'weflow-provider']) {
  const filename = path.join(__dirname, `${name}.ts`)
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  fs.writeFileSync(path.join(compiled, `${name}.js`), js, { mode: 0o600 })
}
const { NativeArchiveService } = require(path.join(compiled, 'native-client.js'))
after(() => {
  const rel = path.relative(tmpRoot, suiteRoot)
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 3 })
})

const syntheticKey = 'd2580045d9ab93df6a43e56b37e99228d85bc8cc9f5450ef132cdfd536582910'
const owner = 'wxid_wal_retry_owner'
const peers = ['wxid_wal_retry_first', 'wxid_wal_retry_second']
const serverIds = ['9223372036854775805', '9223372036854775806']
let serial = 0

function createDb(filename, reserve, prepare) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  let db = new DatabaseSync(filename)
  db.exec('PRAGMA page_size=4096; VACUUM;')
  db.close()
  if (reserve) {
    const header = fs.readFileSync(filename)
    assert.equal(header.readUInt16BE(103), 0)
    header[20] = reserve
    header.writeUInt16BE(4096 - reserve, 105)
    fs.writeFileSync(filename, header, { mode: 0o600 })
  }
  db = new DatabaseSync(filename)
  try { prepare(db); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok') }
  finally { db.close() }
}

function encryptDb(plainFile, encryptedFile) {
  const input = fs.readFileSync(plainFile)
  const salt = crypto.randomBytes(16)
  const key = Buffer.from(syntheticKey, 'hex')
  const macSalt = Buffer.from([...salt].map(byte => byte ^ 0x3a))
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, 'sha512')
  const output = Buffer.alloc(input.length)
  for (let offset = 0, page = 1; offset < input.length; offset += 4096, page++) {
    const skip = page === 1 ? 16 : 0
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false)
    const ciphertext = Buffer.concat([cipher.update(input.subarray(offset + skip, offset + 4016)), cipher.final()])
    if (page === 1) salt.copy(output)
    ciphertext.copy(output, offset + skip)
    iv.copy(output, offset + 4016)
    const pageNumber = Buffer.alloc(4)
    pageNumber.writeUInt32LE(page)
    crypto.createHmac('sha512', macKey).update(ciphertext).update(iv).update(pageNumber).digest().copy(output, offset + 4032)
  }
  fs.mkdirSync(path.dirname(encryptedFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(encryptedFile, output, { mode: 0o600 })
  key.fill(0); macKey.fill(0)
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(file) : [file]
  }).sort()
}
function snapshotBytes(fixture) { return new Map(filesUnder(path.join(fixture.dataRoot, 'native-snapshots')).map(file => [file, fs.readFileSync(file)])) }
function assertReused(before) { for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, 'completed private snapshots remain usable on retry') }
function assertSourceDbs(fixture) { for (const [file, bytes] of fixture.originals) assert.deepEqual(fs.readFileSync(file), bytes, 'source databases are never written') }
function assertNoConnections(fixture) { assert.deepEqual(fs.readdirSync(path.join(fixture.dataRoot, 'native-snapshots')), []) }

function fixture(t, blocked) {
  const root = path.join(suiteRoot, `fixture-${++serial}`)
  const accountPath = path.join(root, owner)
  const dataRoot = path.join(root, 'runtime')
  createDb(path.join(accountPath, 'db_storage/contact/contact.db'), 0, db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY,nick_name TEXT,remark TEXT,alias TEXT)')
    const put = db.prepare('INSERT INTO contact VALUES(?,?,?,?)')
    put.run(owner, '合成本人', '', '')
    peers.forEach((peer, index) => put.run(peer, `合成好友 ${index}`, '', ''))
  })
  createDb(path.join(accountPath, 'db_storage/session/session.db'), 0, db => {
    db.exec('CREATE TABLE SessionTable(username TEXT,sort_timestamp INTEGER)')
    const put = db.prepare('INSERT INTO SessionTable VALUES(?,?)')
    peers.forEach(peer => put.run(peer, 1756684800))
  })
  const messageFiles = peers.map((peer, index) => {
    const seed = path.join(root, `seed-${index}.db`)
    createDb(seed, 80, db => {
      db.exec('CREATE TABLE Name2Id(user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES(?)').run(peer)
      const table = 'Msg_' + crypto.createHash('md5').update(peer).digest('hex')
      db.exec(`CREATE TABLE "${table}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT)`)
      db.prepare(`INSERT INTO "${table}" VALUES(?,?,?,?,?,?)`).run(1, BigInt(serverIds[index]), 1, 1756684800 + index, 1, `合成分库 ${index} 的消息`)
    })
    const file = path.join(accountPath, `db_storage/message/message_${index}.db`)
    encryptDb(seed, file)
    return file
  })
  // These private, synthetic blockers intentionally contain no message frames.
  // Removing them below simulates a completed checkpoint in this fixture only.
  // Never delete a real WeChat WAL to work around the application's refusal.
  blocked.forEach(index => fs.writeFileSync(`${messageFiles[index]}-wal`, Buffer.alloc(32, 7), { mode: 0o600 }))
  const originals = new Map(filesUnder(accountPath).filter(file => file.endsWith('.db')).map(file => [file, fs.readFileSync(file)]))
  const service = new NativeArchiveService({ workerPath: path.join(compiled, 'native-worker.js'), dataRoot })
  t.after(async () => { await service.dispose(); assertNoConnections({ dataRoot }) })
  return { accountPath, dataRoot, messageFiles, originals, service, options: { accountPath, ownerId: owner, ownerName: '合成本人', key: syntheticKey } }
}
function loadOptions(catalog) { return { connectionId: catalog.connectionId, sessionIds: peers, maxMessages: 0, ownerName: '合成本人' } }
async function load(f, catalog) { return f.service.load(loadOptions(catalog), new AbortController().signal, () => {}) }
function assertRecovered(dataset) {
  assert.deepEqual(dataset.messages.map(message => message.originalId), serverIds)
  assert.equal(dataset.coverage.partial, false)
  assert.equal(dataset.coverage.warnings.some(warning => /WAL|没有可读取的消息表/.test(warning)), false)
  assert.equal(JSON.stringify(dataset).includes(syntheticKey), false)
}

test('a partial load retries only the previously WAL-blocked shard and removes its stale failure warning', { timeout: 15000 }, async t => {
  const f = fixture(t, [1])
  const catalog = await f.service.open(f.options)
  const first = await load(f, catalog)
  assert.deepEqual(first.messages.map(message => message.originalId), [serverIds[0]])
  assert.equal(first.coverage.partial, true)
  assert.ok(first.coverage.warnings.some(warning => /message_1\.db.*WAL.*格式/.test(warning)))
  const successfulSnapshots = snapshotBytes(f)
  assert.equal(successfulSnapshots.size, 3)
  const stillBlocked = await load(f, catalog)
  assert.equal(stillBlocked.messages.length, 1)
  assert.equal(stillBlocked.coverage.warnings.filter(warning => /message_1\.db.*WAL.*格式/.test(warning)).length, 1)
  assertReused(successfulSnapshots)
  fs.unlinkSync(`${f.messageFiles[1]}-wal`)
  const retried = await load(f, catalog)
  assertRecovered(retried)
  assertReused(successfulSnapshots)
  assert.equal(snapshotBytes(f).size, 4)
  assertSourceDbs(f)
  await f.service.close({ connectionId: catalog.connectionId })
  assertNoConnections(f)
})

test('when every shard initially fails, a successful retry clears old WAL errors instead of retaining partial coverage', { timeout: 15000 }, async t => {
  const f = fixture(t, [0, 1])
  const catalog = await f.service.open(f.options)
  const catalogSnapshots = snapshotBytes(f)
  assert.equal(catalogSnapshots.size, 2)
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(load(f, catalog), error => {
      assert.match(error.message, /没有成功打开消息数据库/)
      assert.equal((error.message.match(/WAL 文件头格式/g) || []).length, 2, 'one current error per blocked source, without accumulated duplicates')
      return true
    })
    assert.deepEqual([...snapshotBytes(f).keys()], [...catalogSnapshots.keys()], 'failed snapshot outputs must be removed')
  }
  f.messageFiles.forEach(file => fs.unlinkSync(`${file}-wal`))
  const retried = await load(f, catalog)
  assertRecovered(retried)
  assertReused(catalogSnapshots)
  assert.equal(snapshotBytes(f).size, 4)
  assertSourceDbs(f)
  await f.service.close({ connectionId: catalog.connectionId })
  assertNoConnections(f)
})
