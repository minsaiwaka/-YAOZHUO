// Uses only temporary, synthetic SQLite databases; never opens personal data.
// node --test electron/caseboard/database-crypto.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const filename = path.join(__dirname, 'database-crypto.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const isolated = new Module(filename, module)
isolated.filename = filename
isolated.paths = Module._nodeModulePaths(__dirname)
isolated._compile(compiled, filename)
const { createDatabaseSnapshot } = isolated.exports

const rawHex = '18396da7a223436d43c560e3cc62d57cf12ba129b1df5e179133506462d843f1'
const rows = Array.from({ length: 35 }, (_, index) => ({
  id: index + 1, body: `合成测试消息 ${index + 1} ${'忆'.repeat(80)}`, serverId: String(6116895530414915000n + BigInt(index)),
}))

function workspace(t, beforeCleanup) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaozhuo-crypto-test-'))
  t.after(() => { beforeCleanup?.(); fs.rmSync(folder, { recursive: true, force: true }) })
  return folder
}

function populate(db) {
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL, server_id TEXT NOT NULL); BEGIN;')
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?)')
  for (const row of rows) insert.run(row.id, row.body, row.serverId)
  db.exec('COMMIT;')
}

function plainFixture(folder, pageSize = 4096, reserve = 0) {
  const filename = path.join(folder, `plain-${pageSize}-${reserve}.db`)
  let db = new DatabaseSync(filename)
  db.exec(`PRAGMA page_size=${pageSize}; VACUUM;`)
  db.close()
  if (reserve) {
    // Bootstrap an empty, valid SQLite b-tree with reserved page space. SQLite
    // itself then creates every table, cell, overflow page and expected row.
    const bytes = fs.readFileSync(filename)
    assert.equal(bytes.readUInt16BE(103), 0)
    bytes[20] = reserve
    bytes.writeUInt16BE(pageSize - reserve, 105)
    fs.writeFileSync(filename, bytes)
  }
  db = new DatabaseSync(filename)
  populate(db)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, rows.length)
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  db.close()
  return filename
}

function encryptFixture(plain, destination, { pageSize, reserve, digest, iterations, mode = 'raw', key = rawHex }) {
  const input = fs.readFileSync(plain)
  assert.equal(input[20], reserve)
  const salt = crypto.randomBytes(16)
  const pass = /^[a-f\d]{64}$/i.test(key) && mode !== 'passphrase' ? Buffer.from(key, 'hex') : Buffer.from(key)
  const encryptionKey = mode === 'raw' ? pass : crypto.pbkdf2Sync(pass, salt, iterations, 32, digest)
  const macSalt = Buffer.from([...salt].map(byte => byte ^ 0x3a))
  const macKey = crypto.pbkdf2Sync(encryptionKey, macSalt, 2, 32, digest)
  const encrypted = Buffer.alloc(input.length)
  for (let offset = 0, pageNumber = 1; offset < input.length; offset += pageSize, pageNumber += 1) {
    const skip = pageNumber === 1 ? 16 : 0
    const end = pageSize - reserve
    const iv = crypto.randomBytes(16)
    const aes = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv)
    aes.setAutoPadding(false)
    const cipherText = Buffer.concat([aes.update(input.subarray(offset + skip, offset + end)), aes.final()])
    if (pageNumber === 1) salt.copy(encrypted)
    cipherText.copy(encrypted, offset + skip)
    iv.copy(encrypted, offset + end)
    const pageId = Buffer.alloc(4)
    pageId.writeUInt32LE(pageNumber)
    const tag = crypto.createHmac(digest, macKey).update(cipherText).update(iv).update(pageId).digest()
    tag.copy(encrypted, offset + end + 16)
  }
  fs.writeFileSync(destination, encrypted)
  encryptionKey.fill(0); macKey.fill(0)
  return destination
}

function assertSnapshot(destination, reserve) {
  const bytes = fs.readFileSync(destination)
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0')
  assert.equal(bytes[20], reserve, 'reserved bytes must remain excluded from SQLite b-tree usable space')
  assert.equal(bytes[18], 1)
  assert.equal(bytes[19], 1)
  const db = new DatabaseSync(destination, { readOnly: true })
  try {
    assert.deepEqual(db.prepare('SELECT id, body, server_id AS serverId FROM messages ORDER BY id').all().map(row => ({ ...row })), rows)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
  if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600)
}

const profiles = [
  { label: 'SQLCipher4 4096 raw', pageSize: 4096, reserve: 80, digest: 'sha512', iterations: 256000 },
  { label: 'SQLCipher4 4096 PBKDF2 hex input', pageSize: 4096, reserve: 80, digest: 'sha512', iterations: 256000, mode: 'pbkdf2' },
  { label: 'SQLCipher4 passphrase', pageSize: 4096, reserve: 80, digest: 'sha512', iterations: 256000, mode: 'passphrase', key: ' synthetic passphrase with spaces ' },
  { label: 'WeChat3 4096 raw', pageSize: 4096, reserve: 48, digest: 'sha1', iterations: 64000 },
  { label: 'WeChat3 1024 raw', pageSize: 1024, reserve: 48, digest: 'sha1', iterations: 64000 },
  { label: 'WeChat3 4096 PBKDF2 hex input', pageSize: 4096, reserve: 48, digest: 'sha1', iterations: 64000, mode: 'pbkdf2' },
  { label: 'WeChat3 1024 PBKDF2 hex input', pageSize: 1024, reserve: 48, digest: 'sha1', iterations: 64000, mode: 'pbkdf2' },
]
for (const profile of profiles) {
  test(`${profile.label}: recover real SQLite pages and rows without changing source`, async t => {
    const folder = workspace(t)
    const plain = plainFixture(folder, profile.pageSize, profile.reserve)
    const sourcePath = encryptFixture(plain, path.join(folder, 'encrypted.db'), profile)
    const before = fs.readFileSync(sourcePath)
    const destinationPath = path.join(folder, 'snapshot.db')
    const progress = []
    const result = await createDatabaseSnapshot({ sourcePath, destinationPath, key: profile.key ?? rawHex, onProgress: (done, total) => progress.push([done, total]) })
    assert.equal(result.encrypted, true)
    assert.equal(result.walApplied, false)
    assert.deepEqual(result.warnings, [])
    assert.match(result.format, new RegExp(`${profile.pageSize}-`))
    assert.deepEqual(progress.at(-1), [before.length, before.length])
    assert.deepEqual(fs.readFileSync(sourcePath), before)
    assertSnapshot(destinationPath, profile.reserve)
    assert.equal(fs.readdirSync(folder).some(file => file.startsWith('.database-snapshot-')), false)
  })
}

test('multi-megabyte main DB keeps all authenticated pages across read/write batches', async t => {
  const folder = workspace(t)
  const plain = plainFixture(folder, 4096, 80)
  const db = new DatabaseSync(plain)
  db.exec('CREATE TABLE payload(id INTEGER PRIMARY KEY, body TEXT); BEGIN;')
  const put = db.prepare('INSERT INTO payload VALUES(?,?)')
  for (let index = 0; index < 700; index++) put.run(index + 1, `跨批次資料 ${index}：${'字'.repeat(2000)}`)
  db.exec('COMMIT;'); db.close()
  const sourcePath = encryptFixture(plain, path.join(folder, 'large-encrypted.db'), profiles[0])
  const before = fs.readFileSync(sourcePath)
  assert(before.length > 4 * 1024 * 1024)
  const destinationPath = path.join(folder, 'large-snapshot.db')
  await createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex })
  const snapshot = new DatabaseSync(destinationPath, { readOnly: true })
  try {
    const output = snapshot.prepare('SELECT * FROM payload ORDER BY id').all()
    assert.equal(output.length, 700)
    for (const row of output) assert.equal(row.body, `跨批次資料 ${row.id - 1}：${'字'.repeat(2000)}`)
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { snapshot.close() }
  assert.deepEqual(fs.readFileSync(sourcePath), before)
  const corrupted = Buffer.from(before); corrupted[2 * 1024 * 1024 + 100] ^= 0x40; fs.writeFileSync(sourcePath, corrupted)
  const refused = path.join(folder, 'must-not-exist.db')
  await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath: refused, key: rawHex }), /认证/)
  assert.equal(fs.existsSync(refused), false)
  assert.equal(fs.readdirSync(folder).some(file => file.startsWith('.database-snapshot-')), false)
})

test('plaintext WAL backup includes committed latest rows while source DB, WAL and SHM stay byte-identical', async t => {
  let db
  const folder = workspace(t, () => db?.close())
  const sourcePath = path.join(folder, 'live.db')
  db = new DatabaseSync(sourcePath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  populate(db)
  db.exec("INSERT INTO messages VALUES (99, 'WAL 中的新消息', '9223372036854775807');")
  assert(fs.statSync(`${sourcePath}-wal`).size > 32)
  const suffixes = ['', '-wal', '-shm']
  const original = suffixes.map(suffix => fs.readFileSync(`${sourcePath}${suffix}`))
  const destinationPath = path.join(folder, 'snapshot.db')
  const result = await createDatabaseSnapshot({ sourcePath, destinationPath, key: '' })
  assert.equal(result.encrypted, false)
  assert.equal(result.walApplied, true)
  assert.equal(result.format, 'SQLite3')
  const snapshot = new DatabaseSync(destinationPath, { readOnly: true })
  try {
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM messages').get().n, rows.length + 1)
    assert.equal(snapshot.prepare('SELECT body FROM messages WHERE id=99').get().body, 'WAL 中的新消息')
  } finally { snapshot.close() }
  suffixes.forEach((suffix, index) => assert.deepEqual(fs.readFileSync(`${sourcePath}${suffix}`), original[index]))
  assert.equal(fs.readdirSync(folder).some(file => file.startsWith('.database-snapshot-')), false)
})

test('ordinary plaintext SQLite is backed up and an existing output is never overwritten', async t => {
  const folder = workspace(t)
  const sourcePath = plainFixture(folder)
  const destinationPath = path.join(folder, 'snapshot.db')
  const sourceBytes = fs.readFileSync(sourcePath)
  const result = await createDatabaseSnapshot({ sourcePath, destinationPath, key: '' })
  assert.equal(result.walApplied, false)
  assertSnapshot(destinationPath, 0)
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes)
  const output = fs.readFileSync(destinationPath)
  await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: '' }), /已存在/)
  assert.deepEqual(fs.readFileSync(destinationPath), output)
  await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath: sourcePath, key: '' }), /原数据库/)
})

test('wrong key, first-page tampering, and later-page tampering fail closed and remove plaintext output', async t => {
  const folder = workspace(t)
  const profile = profiles[0]
  const plain = plainFixture(folder, profile.pageSize, profile.reserve)
  for (const problem of ['wrong-key', 'first-page', 'later-page']) {
    const sourcePath = encryptFixture(plain, path.join(folder, `${problem}.db`), profile)
    const destinationPath = path.join(folder, `${problem}-snapshot.db`)
    if (problem !== 'wrong-key') {
      const bytes = fs.readFileSync(sourcePath)
      bytes[problem === 'first-page' ? 32 : profile.pageSize + 32] ^= 1
      fs.writeFileSync(sourcePath, bytes)
    }
    await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: problem === 'wrong-key' ? '01'.repeat(32) : rawHex }), /密钥不匹配|认证失败/)
    assert.equal(fs.existsSync(destinationPath), false)
  }
})

test('malformed encrypted WAL and nonempty rollback journal are refused instead of losing messages', async t => {
  const folder = workspace(t)
  const profile = profiles[0]
  const plain = plainFixture(folder, profile.pageSize, profile.reserve)
  const sourcePath = encryptFixture(plain, path.join(folder, 'encrypted.db'), profile)
  for (const suffix of ['-wal', '-journal']) {
    fs.writeFileSync(`${sourcePath}${suffix}`, Buffer.alloc(128, 7))
    const destinationPath = path.join(folder, `${suffix}-snapshot.db`)
    await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex }), suffix === '-wal' ? /WAL.*格式/ : /非空回滚日志/)
    assert.equal(fs.existsSync(destinationPath), false)
    assert.equal(fs.statSync(`${sourcePath}${suffix}`).size, 128)
    fs.unlinkSync(`${sourcePath}${suffix}`)
  }
})

test('cancellation before starting and during page decryption removes every partial output', async t => {
  const folder = workspace(t)
  const profile = profiles[0]
  const plain = plainFixture(folder, profile.pageSize, profile.reserve)
  const sourcePath = encryptFixture(plain, path.join(folder, 'encrypted.db'), profile)
  for (const preCancelled of [true, false]) {
    const control = new AbortController()
    if (preCancelled) control.abort()
    const destinationPath = path.join(folder, `cancel-${preCancelled}.db`)
    await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex, signal: control.signal, onProgress: done => { if (done > 0) control.abort() } }), { name: 'AbortError' })
    assert.equal(fs.existsSync(destinationPath), false)
  }
})

test('a WAL appearing after stable capture does not invalidate the captured point in time or change source files', async t => {
  const folder = workspace(t)
  const profile = profiles[0]
  const plain = plainFixture(folder, profile.pageSize, profile.reserve)
  const sourcePath = encryptFixture(plain, path.join(folder, 'encrypted.db'), profile)
  const destinationPath = path.join(folder, 'snapshot.db')
  const original = fs.readFileSync(sourcePath)
  const laterWal = Buffer.alloc(32, 1)
  const result = await createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex, onProgress: done => { if (done > 0) fs.writeFileSync(`${sourcePath}-wal`, laterWal) } })
  assert.equal(result.walApplied, false)
  assertSnapshot(destinationPath, profile.reserve)
  assert.deepEqual(fs.readFileSync(sourcePath), original)
  assert.deepEqual(fs.readFileSync(`${sourcePath}-wal`), laterWal)
})

test('cancelling plaintext backup removes the snapshot and private DB/WAL copies', async t => {
  const folder = workspace(t)
  const sourcePath = plainFixture(folder)
  const db = new DatabaseSync(sourcePath)
  try {
    db.exec('CREATE TABLE bulk (data BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<150) INSERT INTO bulk SELECT zeroblob(4096) FROM n;')
  } finally { db.close() }
  const original = fs.readFileSync(sourcePath)
  const destinationPath = path.join(folder, 'cancel.db')
  const control = new AbortController()
  await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: '', signal: control.signal, onProgress: done => { if (done > 0) control.abort() } }), { name: 'AbortError' })
  assert.equal(fs.existsSync(destinationPath), false)
  assert.deepEqual(fs.readFileSync(sourcePath), original)
  assert.equal(fs.readdirSync(folder).some(file => file.startsWith('.database-snapshot-')), false)
})

test('existing destination sidecars are never reused or removed', async t => {
  const folder = workspace(t)
  const sourcePath = plainFixture(folder)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const destinationPath = path.join(folder, `${suffix}-output.db`)
    const sidecar = `${destinationPath}${suffix}`
    const original = Buffer.from('existing unrelated data')
    fs.writeFileSync(sidecar, original)
    await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath, key: '' }), /附属文件/)
    assert.equal(fs.existsSync(destinationPath), false)
    assert.deepEqual(fs.readFileSync(sidecar), original)
  }
})

test('empty encrypted WAL is allowed, but a truncated database is refused', async t => {
  const folder = workspace(t)
  const profile = profiles[0]
  const plain = plainFixture(folder, profile.pageSize, profile.reserve)
  const sourcePath = encryptFixture(plain, path.join(folder, 'encrypted.db'), profile)
  fs.writeFileSync(`${sourcePath}-wal`, Buffer.alloc(0))
  const destinationPath = path.join(folder, 'snapshot.db')
  const result = await createDatabaseSnapshot({ sourcePath, destinationPath, key: rawHex })
  assert.equal(result.walApplied, false)
  assertSnapshot(destinationPath, profile.reserve)
  fs.truncateSync(sourcePath, fs.statSync(sourcePath).size - 1)
  const brokenOutput = path.join(folder, 'broken.db')
  await assert.rejects(createDatabaseSnapshot({ sourcePath, destinationPath: brokenOutput, key: rawHex }), /格式暂不支持/)
  assert.equal(fs.existsSync(brokenOutput), false)
})
