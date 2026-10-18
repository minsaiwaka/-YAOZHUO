// Real native-worker protocol regression using only synthetic SQLite fixtures.
// Contact/session rows and the high precision message IDs exist only in WAL.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')

const temporaryRoot = path.resolve(__dirname, '../../.caseboard-data/tmp')
fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
const suiteRoot = fs.mkdtempSync(path.join(temporaryRoot, 'native-catalog-wal-'))
const compiled = path.join(suiteRoot, 'compiled')
fs.mkdirSync(compiled, { mode: 0o700 })
for (const name of ['native-client', 'native-worker', 'native-reader', 'database-crypto', 'native-discovery', 'native-media', 'auto-key', 'image-keys', 'weflow-profile', 'weflow-provider']) {
  const filename = path.join(__dirname, `${name}.ts`)
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  fs.writeFileSync(path.join(compiled, `${name}.js`), js, { mode: 0o600 })
}
const { NativeArchiveService } = require(path.join(compiled, 'native-client.js'))
after(() => {
  const relative = path.relative(temporaryRoot, suiteRoot)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 3 })
})

const pageSize = 4096
const reserve = 80
const syntheticKey = 'fe1ac1577809ab25c0c42c8ab26dc5a445a900024850575921c1bfcd6d241978'
const owner = 'wxid_catalog_wal_owner'
const peer = 'wxid_catalog_wal_only_peer'
const serverIds = ['9223372036854775806', '9223372036854775807']

function checksum(bytes, seed, little) {
  assert.equal(bytes.length % 8, 0)
  let [first, second] = seed
  for (let index = 0; index < bytes.length; index += 8) {
    const left = little ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index)
    const right = little ? bytes.readUInt32LE(index + 4) : bytes.readUInt32BE(index + 4)
    first = (first + left + second) >>> 0
    second = (second + right + first) >>> 0
  }
  return [first, second]
}

function walChecksums(wal, rewrite = false) {
  assert.equal(wal.readUInt32BE(4), 3007000)
  assert.equal(wal.readUInt32BE(8), pageSize)
  assert.equal((wal.length - 32) % (pageSize + 24), 0)
  const magic = wal.readUInt32BE(0)
  assert([0x377f0682, 0x377f0683].includes(magic))
  const little = magic === 0x377f0682
  let rolling = checksum(wal.subarray(0, 24), [0, 0], little)
  const storeOrCheck = (offset, value) => rewrite ? wal.writeUInt32BE(value, offset) : assert.equal(wal.readUInt32BE(offset), value)
  storeOrCheck(24, rolling[0]); storeOrCheck(28, rolling[1])
  for (let offset = 32; offset < wal.length; offset += pageSize + 24) {
    assert(wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24)))
    rolling = checksum(wal.subarray(offset, offset + 8), rolling, little)
    rolling = checksum(wal.subarray(offset + 24, offset + 24 + pageSize), rolling, little)
    storeOrCheck(offset + 16, rolling[0]); storeOrCheck(offset + 20, rolling[1])
  }
}

function sqliteFixture(filename, baseline, commits) {
  let db = new DatabaseSync(filename)
  db.exec(`PRAGMA page_size=${pageSize}; VACUUM;`)
  db.close()
  const bootstrap = fs.readFileSync(filename)
  assert.equal(bootstrap.readUInt16BE(103), 0)
  bootstrap[20] = reserve
  bootstrap.writeUInt16BE(pageSize - reserve, 105)
  fs.writeFileSync(filename, bootstrap)
  db = new DatabaseSync(filename)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    baseline(db)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    const base = fs.readFileSync(filename)
    assert.equal(fs.statSync(`${filename}-wal`).size, 0)
    commits(db)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const wal = fs.readFileSync(`${filename}-wal`)
    const shm = fs.readFileSync(`${filename}-shm`)
    assert(wal.length > 32)
    walChecksums(wal)
    assert.deepEqual(fs.readFileSync(filename), base, 'committed new records have not entered the main database')
    return { base, wal, shm }
  } finally { db.close() }
}

function encryptFixture(plain, destination, transformWal) {
  const salt = crypto.randomBytes(16)
  const key = Buffer.from(syntheticKey, 'hex')
  const macSalt = Buffer.from([...salt].map(byte => byte ^ 0x3a))
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, 'sha512')
  const encryptPage = (page, number) => {
    const skip = number === 1 ? 16 : 0
    const reserveStart = pageSize - reserve
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false)
    const encrypted = Buffer.concat([cipher.update(page.subarray(skip, reserveStart)), cipher.final()])
    const output = Buffer.alloc(pageSize)
    if (number === 1) salt.copy(output)
    encrypted.copy(output, skip)
    iv.copy(output, reserveStart)
    const pageNumber = Buffer.alloc(4)
    pageNumber.writeUInt32LE(number)
    crypto.createHmac('sha512', macKey).update(encrypted).update(iv).update(pageNumber).digest().copy(output, reserveStart + 16)
    return output
  }
  try {
    const base = Buffer.alloc(plain.base.length)
    for (let offset = 0; offset < base.length; offset += pageSize) {
      encryptPage(plain.base.subarray(offset, offset + pageSize), offset / pageSize + 1).copy(base, offset)
    }
    const wal = Buffer.from(plain.wal)
    for (let offset = 32; offset < wal.length; offset += pageSize + 24) {
      const number = wal.readUInt32BE(offset)
      encryptPage(plain.wal.subarray(offset + 24, offset + 24 + pageSize), number).copy(wal, offset + 24)
    }
    walChecksums(wal, true)
    walChecksums(wal)
    const storedWal = transformWal ? transformWal(wal) : wal
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.writeFileSync(destination, base, { mode: 0o600 })
    fs.writeFileSync(`${destination}-wal`, storedWal, { mode: 0o600 })
    fs.writeFileSync(`${destination}-shm`, plain.shm, { mode: 0o600 })
    return ['', '-wal', '-shm'].map(suffix => [destination + suffix, fs.readFileSync(destination + suffix)])
  } finally { key.fill(0); macKey.fill(0); macSalt.fill(0) }
}

test('real catalog worker reads contacts, sessions and exact message IDs committed only in encrypted WAL', { timeout: 15000 }, async t => {
  const accountPath = path.join(suiteRoot, owner)
  const dataRoot = path.join(suiteRoot, 'runtime')
  const originals = new Map()
  const add = (name, baseline, commits) => {
    const plain = sqliteFixture(path.join(suiteRoot, `${name}.sqlite`), baseline, commits)
    const file = path.join(accountPath, `db_storage/${name}/${name === 'message' ? 'message_0' : name}.db`)
    for (const [source, bytes] of encryptFixture(plain, file)) originals.set(source, bytes)
  }
  add('contact', db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY,nick_name TEXT,remark TEXT,alias TEXT)')
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(owner, '合成本人', '', '')
    assert.equal(db.prepare('SELECT count(*) AS n FROM contact WHERE username=?').get(peer).n, 0)
  }, db => {
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(peer, '仅在 WAL 中的好友', '', 'wal_only_alias')
    db.prepare('UPDATE contact SET remark=? WHERE username=?').run('WAL 最终联系人备注', peer)
  })
  add('session', db => {
    db.exec('CREATE TABLE SessionTable(username TEXT,sort_timestamp INTEGER)')
    assert.equal(db.prepare('SELECT count(*) AS n FROM SessionTable').get().n, 0)
  }, db => {
    db.prepare('INSERT INTO SessionTable VALUES(?,?)').run(peer, 1756684800)
  })
  const table = 'Msg_' + crypto.createHash('md5').update(peer).digest('hex')
  add('message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)')
    db.exec(`CREATE TABLE "${table}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT)`)
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n, 0)
  }, db => {
    db.prepare('INSERT INTO Name2Id VALUES(?)').run(peer)
    const insert = db.prepare(`INSERT INTO "${table}" VALUES(?,?,?,?,?,?)`)
    insert.run(1, BigInt(serverIds[0]), 1, 1756684800, 1, '第一条仅存在于加密 WAL 的消息')
    insert.run(2, BigInt(serverIds[1]), 1, 1756684801, 1, '最大有符号 64 位消息 ID 保持完整')
  })
  const assertSourcesUnchanged = () => {
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes, `source ${path.basename(file)} must not be written`)
  }
  const workerPath = process.env.YAOZHUO_TEST_BUNDLED_WORKER || path.join(compiled, 'native-worker.js')
  const service = new NativeArchiveService({ workerPath, dataRoot })
  t.after(async () => {
    await service.dispose()
    assertSourcesUnchanged()
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'native-snapshots')), [], 'closing the worker removes its own private snapshots')
  })
  const catalog = await service.open({ accountPath, ownerId: owner, ownerName: '合成本人', key: syntheticKey })
  assert.equal(catalog.databaseCount, 3)
  assert.deepEqual(catalog.warnings, [])
  const person = catalog.people.find(person => person.id === peer)
  assert.equal(person?.name, 'WAL 最终联系人备注')
  assert.equal(person?.alias, 'wal_only_alias')
  assert.deepEqual(catalog.sessions.map(session => ({ id: session.id, name: session.name })), [{ id: peer, name: person.name }])
  assertSourcesUnchanged()
  const dataset = await service.load({ connectionId: catalog.connectionId, sessionIds: [peer], maxMessages: 0, ownerName: '合成本人' }, new AbortController().signal, () => {})
  assert.deepEqual(dataset.messages.map(message => message.originalId), serverIds)
  assert.deepEqual(dataset.messages.map(message => message.content), ['第一条仅存在于加密 WAL 的消息', '最大有符号 64 位消息 ID 保持完整'])
  assert.equal(dataset.coverage.partial, false)
  assert.equal(dataset.coverage.warnings.some(warning => /WAL|失败|未识别|无法/.test(warning)), false)
  assert.equal(JSON.stringify({ catalog, dataset }).includes(syntheticKey), false)
  assertSourcesUnchanged()
  await service.close({ connectionId: catalog.connectionId })
  assertSourcesUnchanged()
})

// A restart writes a new, checksum-valid WAL header without truncating older
// frames. Until a frame in the current generation is committed, SQLite must
// read the checkpointed database, not reject its unrelated older tail.
function resetWalGeneration(input) {
  const wal = Buffer.from(input)
  wal[16] ^= 0x80
  wal[20] ^= 0x40
  const rolling = checksum(wal.subarray(0, 24), [0, 0], wal.readUInt32BE(0) === 0x377f0682)
  wal.writeUInt32BE(rolling[0], 24)
  wal.writeUInt32BE(rolling[1], 28)
  assert.equal(wal.subarray(16, 24).equals(wal.subarray(40, 48)), false)
  return wal
}

function appendOldGenerationFrame(input) {
  const frame = Buffer.from(input.subarray(input.length - pageSize - 24))
  frame[8] ^= 0x20
  return Buffer.concat([input, frame])
}

function makeResetCatalog(label, damage) {
  const fixtureRoot = path.join(suiteRoot, label)
  const accountPath = path.join(fixtureRoot, owner)
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 })
  const originals = new Map()
  const add = (name, baseline, commits, transformWal) => {
    const plain = sqliteFixture(path.join(fixtureRoot, `${name}.sqlite`), baseline, commits)
    const file = path.join(accountPath, `db_storage/${name}/${name === 'message' ? 'message_0' : name}.db`)
    const encrypted = encryptFixture(plain, file, transformWal)
    for (const [source, bytes] of encrypted) originals.set(source, bytes)
    return { plain, file }
  }
  add('contact', db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY,nick_name TEXT,remark TEXT,alias TEXT)')
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(owner, '合成本人', '', '')
  }, db => {
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(peer, '有效提交中的好友', '舊尾不得遮蔽已提交備註', 'wal_restart_alias')
  }, appendOldGenerationFrame)
  const session = add('session', db => {
    db.exec('CREATE TABLE SessionTable(username TEXT,sort_timestamp INTEGER)')
    db.prepare('INSERT INTO SessionTable VALUES(?,?)').run(peer, 1756684800)
  }, db => {
    // These old-generation transactions end at the already-checkpointed value.
    db.prepare('UPDATE SessionTable SET sort_timestamp=?').run(1756684801)
    db.prepare('UPDATE SessionTable SET sort_timestamp=?').run(1756684800)
  }, resetWalGeneration)
  const table = 'Msg_' + crypto.createHash('md5').update(peer).digest('hex')
  add('message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)')
    db.exec(`CREATE TABLE "${table}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT)`)
  }, db => {
    db.prepare('INSERT INTO Name2Id VALUES(?)').run(peer)
    const insert = db.prepare(`INSERT INTO "${table}" VALUES(?,?,?,?,?,?)`)
    insert.run(1, BigInt(serverIds[0]), 1, 1756684800, 1, '有效代際的消息')
    insert.run(2, BigInt(serverIds[1]), 1, 1756684801, 1, '完整的 64 位消息 ID')
  })

  // Verify the reset fixture's meaning independently with the real SQLite WAL
  // reader before asking our encrypted reader to produce the same result.
  const referencePath = path.join(fixtureRoot, 'reference-session.sqlite')
  fs.writeFileSync(referencePath, session.plain.base)
  fs.writeFileSync(`${referencePath}-wal`, resetWalGeneration(session.plain.wal))
  const reference = new DatabaseSync(referencePath, { readOnly: true })
  try {
    assert.deepEqual({ ...reference.prepare('SELECT * FROM SessionTable').get() }, { username: peer, sort_timestamp: 1756684800 })
    assert.equal(reference.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  } finally { reference.close() }

  if (damage) {
    const damagedPath = damage === 'header' ? `${session.file}-wal` : session.file
    const bytes = fs.readFileSync(damagedPath)
    if (damage === 'header') bytes[24] ^= 1 // Current-generation header checksum really is invalid.
    else bytes[pageSize - reserve + 16] ^= 1 // First main page fails SQLCipher HMAC.
    fs.writeFileSync(damagedPath, bytes)
    originals.set(damagedPath, Buffer.from(bytes))
  }
  return {
    accountPath,
    dataRoot: path.join(fixtureRoot, 'runtime'),
    assertSourcesUnchanged: () => {
      for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes, `source ${path.basename(file)} must not be written`)
    },
  }
}

test('catalog accepts a reset WAL with only older frames while preserving valid contact WAL commits', { timeout: 15000 }, async t => {
  const fixture = makeResetCatalog('reset-catalog')
  const workerPath = process.env.YAOZHUO_TEST_BUNDLED_WORKER || path.join(compiled, 'native-worker.js')
  const service = new NativeArchiveService({ workerPath, dataRoot: fixture.dataRoot })
  t.after(async () => { await service.dispose(); fixture.assertSourcesUnchanged() })
  const catalog = await service.open({ accountPath: fixture.accountPath, ownerId: owner, ownerName: '合成本人', key: syntheticKey })
  assert.equal(catalog.people.find(person => person.id === peer)?.name, '舊尾不得遮蔽已提交備註')
  assert.deepEqual(catalog.sessions.map(session => session.id), [peer])
  fixture.assertSourcesUnchanged()
  const dataset = await service.load({ connectionId: catalog.connectionId, sessionIds: [peer], maxMessages: 0, ownerName: '合成本人' }, new AbortController().signal, () => {})
  assert.deepEqual(dataset.messages.map(message => message.originalId), serverIds)
  assert.deepEqual(dataset.messages.map(message => message.content), ['有效代際的消息', '完整的 64 位消息 ID'])
  assert.equal(JSON.stringify({ catalog, dataset }).includes(syntheticKey), false)
  fixture.assertSourcesUnchanged()
  await service.close({ connectionId: catalog.connectionId })
  fixture.assertSourcesUnchanged()
})

for (const damage of ['header', 'hmac']) test(`catalog failure lists only the unreadable session for genuine ${damage} damage`, { timeout: 15000 }, async t => {
  const fixture = makeResetCatalog(`damaged-reset-${damage}`, damage)
  const workerPath = process.env.YAOZHUO_TEST_BUNDLED_WORKER || path.join(compiled, 'native-worker.js')
  const service = new NativeArchiveService({ workerPath, dataRoot: fixture.dataRoot })
  t.after(async () => { await service.dispose(); fixture.assertSourcesUnchanged() })
  await assert.rejects(service.open({ accountPath: fixture.accountPath, ownerId: owner, ownerName: '合成本人', key: syntheticKey }), error => {
    assert.match(error.message, /联系人或会话数据库未能打开/)
    assert.match(error.message, /db_storage\/session\/session\.db/)
    assert.doesNotMatch(error.message, /db_storage\/contact\/contact\.db/, 'a successful contact snapshot warning must not be presented as an open failure')
    assert.equal(error.message.includes(syntheticKey), false)
    return true
  })
  fixture.assertSourcesUnchanged()
})
