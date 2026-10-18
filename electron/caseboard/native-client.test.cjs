// Real worker/service integration, using only synthetic account databases.
// node --test electron/caseboard/native-client.test.cjs
// All compiled modules and fixtures stay in this project's .caseboard-data/tmp.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { zstdCompressSync } = require('node:zlib')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '../..')
const tmpRoot = path.join(projectRoot, '.caseboard-data', 'tmp')
fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
const suiteRoot = fs.mkdtempSync(path.join(tmpRoot, 'native-client-test-'))
const compiledRoot = path.join(suiteRoot, 'compiled')
fs.mkdirSync(compiledRoot, { mode: 0o700 })
for (const name of ['native-client', 'native-worker', 'native-reader', 'database-crypto', 'native-discovery', 'native-media', 'auto-key', 'image-keys', 'weflow-profile', 'weflow-provider']) {
  const filename = path.join(__dirname, `${name}.ts`)
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  })
  fs.writeFileSync(path.join(compiledRoot, `${name}.js`), result.outputText, { mode: 0o600 })
}
const { NativeArchiveService } = require(path.join(compiledRoot, 'native-client.js'))
const { discoverAccounts, findSourceDatabases, isInside } = require(path.join(compiledRoot, 'native-discovery.js'))
const { decodeLocalImage } = require(path.join(compiledRoot, 'native-media.js'))
const { autoConfigure } = require(path.join(compiledRoot, 'auto-key.js'))
const { discoverImageKeys, verifyImageCandidate } = require(path.join(compiledRoot, 'image-keys.js'))

after(() => {
  const rel = path.relative(tmpRoot, suiteRoot)
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'remove only the suite directory created inside the project tmp root')
  fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 3 })
})

const ownerId = 'wxid_synthetic_owner'
const peerId = 'wxid_synthetic_peer'
const ownerName = '合成测试本人'
const contactKey = 'd2580045d9ab93df6a43e56b37e99228d85bc8cc9f5450ef132cdfd536582910'
const messageKey = '256c5f79ac313a391f0ea3d045e146c674e304e919b21236da0a0ebd20be4c91'
const incorrectKey = 'aa'.repeat(32)
const imageKey = 'SyntheticImage16'
const firstServerId = '9223372036854775805'
const selfServerId = '9223372036854775806'
const imageServerId = '9007199254740993'
const unsignedServerId = '18446744073709551615'
const timestamp = 1756684800
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=', 'base64')
const mediaMd5 = crypto.createHash('md5').update(png).digest('hex')
const tableName = `Msg_${crypto.createHash('md5').update(peerId).digest('hex')}`
let nextFixture = 0

function database(filename, reserve, prepare) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  let db = new DatabaseSync(filename)
  db.exec('PRAGMA page_size=4096; VACUUM;')
  db.close()
  if (reserve) {
    // Empty SQLite b-tree bootstrap. All actual schema/cells/overflow pages
    // below are then created by SQLite itself using the reserved page bytes.
    const bytes = fs.readFileSync(filename)
    assert.equal(bytes.readUInt16BE(103), 0)
    bytes[20] = reserve
    bytes.writeUInt16BE(4096 - reserve, 105)
    fs.writeFileSync(filename, bytes, { mode: 0o600 })
  }
  db = new DatabaseSync(filename)
  try {
    prepare(db)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
}

function encryptSqlCipher4(source, destination, keyHex, derived = false) {
  const plain = fs.readFileSync(source)
  assert.equal(plain[20], 80)
  const salt = crypto.randomBytes(16)
  const input = Buffer.from(keyHex, 'hex')
  const encKey = derived ? crypto.pbkdf2Sync(input, salt, 256000, 32, 'sha512') : input
  const macSalt = Buffer.from([...salt].map(byte => byte ^ 0x3a))
  const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512')
  const output = Buffer.alloc(plain.length)
  for (let offset = 0, page = 1; offset < plain.length; offset += 4096, page++) {
    const skip = page === 1 ? 16 : 0
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv)
    cipher.setAutoPadding(false)
    const encrypted = Buffer.concat([cipher.update(plain.subarray(offset + skip, offset + 4016)), cipher.final()])
    if (page === 1) salt.copy(output)
    encrypted.copy(output, offset + skip)
    iv.copy(output, offset + 4016)
    const pageBytes = Buffer.alloc(4)
    pageBytes.writeUInt32LE(page)
    crypto.createHmac('sha512', macKey).update(encrypted).update(iv).update(pageBytes).digest().copy(output, offset + 4032)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.writeFileSync(destination, output, { mode: 0o600 })
  encKey.fill(0); input.fill(0); macKey.fill(0)
  return salt.toString('hex')
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(filename) : [filename]
  }).sort()
}
function originalBytes(directory) {
  return new Map(filesUnder(directory).map(filename => [path.relative(directory, filename), fs.readFileSync(filename)]))
}
function assertOriginals(fixture) {
  const actual = originalBytes(fixture.accountPath)
  assert.deepEqual([...actual.keys()], [...fixture.originals.keys()], 'no new sidecars may be created in the source account')
  for (const [filename, before] of fixture.originals) assert.deepEqual(actual.get(filename), before, `source file changed: ${filename}`)
}
function snapshotFiles(fixture) { return filesUnder(path.join(fixture.dataRoot, 'native-snapshots')) }
function assertNoConnections(fixture) {
  const root = path.join(fixture.dataRoot, 'native-snapshots')
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], [], 'closing removes the complete private account directory')
}

function fixture(t, { derivedMessages = false, extraMessages = 0 } = {}) {
  const root = path.join(suiteRoot, `case-${++nextFixture}`)
  const accountPath = path.join(root, ownerId)
  const dataRoot = path.join(root, 'runtime')
  const contactPlain = path.join(root, 'seed-contact.db')
  const messagePlain = path.join(root, 'seed-message.db')
  database(contactPlain, 80, db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT, alias TEXT, local_type INTEGER)')
    const put = db.prepare('INSERT INTO contact VALUES(?,?,?,?,?)')
    put.run(ownerId, '旧本人昵称', '', '', 1)
    put.run(peerId, '合成好友昵称', '合成好友备注', 'fixture-alias', 1)
  })
  encryptSqlCipher4(contactPlain, path.join(accountPath, 'db_storage/contact/contact.db'), contactKey)
  database(path.join(accountPath, 'db_storage/session/session.db'), 0, db => {
    db.exec('CREATE TABLE SessionTable(username TEXT, sort_timestamp INTEGER, summary TEXT)')
    db.prepare('INSERT INTO SessionTable VALUES(?,?,?)').run(peerId, timestamp, '合成会话')
  })
  database(messagePlain, 80, db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)')
    const name = db.prepare('INSERT INTO Name2Id VALUES(?)')
    name.run(ownerId); name.run(peerId)
    db.exec(`CREATE TABLE "${tableName}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,compress_content BLOB,source TEXT)`)
    const put = db.prepare(`INSERT INTO "${tableName}" VALUES(?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    put.run(1, BigInt(firstServerId), 1, timestamp, 2, '', zstdCompressSync(Buffer.from('我喜欢摄影和旧书店。')), '')
    put.run(2, BigInt(selfServerId), 49, timestamp + 1, 1, `<msg><appmsg><title>一起去看看</title><type>57</type><refermsg><svrid>${firstServerId}</svrid></refermsg></appmsg></msg>`, null, '')
    put.run(3, BigInt(imageServerId), 3, timestamp + 2, 2, `<msg><img md5="${mediaMd5}" cdnthumburl="https://never-request.invalid/fixture.png" /></msg>`, null, '')
    put.run(4, -1n, 1, timestamp + 3, 2, '带符号存储的原始 64 位标识', null, '')
    for (let index = 0; index < extraMessages; index++) put.run(index + 5, 100000n + BigInt(index), 1, timestamp + 4 + index, index % 2 + 1, `额外合成消息 ${index}`, null, '')
    db.exec('COMMIT')
  })
  const salt = encryptSqlCipher4(messagePlain, path.join(accountPath, 'db_storage/message/message_0.db'), messageKey, derivedMessages)
  const imagePath = path.join(accountPath, 'msg/attach/synthetic/image', `${mediaMd5}.png`)
  fs.mkdirSync(path.dirname(imagePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(imagePath, png, { mode: 0o600 })
  const service = new NativeArchiveService({ workerPath: path.join(compiledRoot, 'native-worker.js'), dataRoot, documents: path.join(root, 'empty-documents'), profileOptions: { configPaths: [] } })
  t.after(async () => { await service.dispose(); assertNoConnections({ dataRoot }) })
  const keysJSON = JSON.stringify({ 'db_storage/message/message_0.db': messageKey })
  const openOptions = { accountPath, ownerId, ownerName, key: contactKey, keys: JSON.parse(keysJSON), imageKey, xorKey: 0 }
  return { root, accountPath, dataRoot, service, salt, keysJSON, openOptions, originals: originalBytes(accountPath) }
}

function loadOptions(catalog, maxMessages = 0) { return { connectionId: catalog.connectionId, sessionIds: [peerId], maxMessages, ownerName } }

test('automatic fill authenticates helper candidates and never fills an invalid or other-account key', async t => {
  const f = fixture(t)
  const contactSalt = fs.readFileSync(path.join(f.accountPath, 'db_storage/contact/contact.db')).subarray(0, 16).toString('hex')
  const events = []
  const result = await autoConfigure({ accountPath: f.accountPath }, {
    helperPath: '', signal: new AbortController().signal, progress: value => events.push(value),
    scan: async salts => {
      assert(salts.includes(contactSalt)); assert(salts.includes(f.salt))
      return { processes: 1, denied: false, limited: false, candidates: [{ key: incorrectKey, salt: contactSalt }, { key: messageKey, salt: '11'.repeat(16) }, { key: contactKey, salt: contactSalt }, { key: messageKey, salt: f.salt }] }
    },
  })
  assert.equal(result.status, 'ready'); assert.equal(result.verifiedDatabases, 3)
  assert.equal(result.configuration.ownerId, ownerId)
  assert.equal(result.configuration.key, contactKey)
  assert.equal(result.configuration.keys['db_storage/message/message_0.db'], messageKey)
  assert.equal(JSON.stringify(result.configuration).includes(incorrectKey), false)
  for (const secret of [contactKey, messageKey, incorrectKey]) assert.equal(JSON.stringify(events).includes(secret), false)
  const catalog = await f.service.open(result.configuration)
  assert.equal((await f.service.load(loadOptions(catalog), new AbortController().signal, () => {})).messages.length, 4)
  assertOriginals(f)
})

test('automatic fill uses only validated account-local key files and supports a live-process-free retry cache', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.accountPath, 'all_keys.json'), JSON.stringify({ 'db_storage/contact/contact.db': contactKey, 'db_storage/message/message_0.db': { key: messageKey, salt: f.salt } }))
  const result = await autoConfigure({ accountPath: f.accountPath }, { helperPath: '', signal: new AbortController().signal, progress() {}, scan: async () => { throw new Error('must not scan when all keys were authenticated') } })
  assert.equal(result.status, 'ready')
  const g = fixture(t)
  const catalog = await g.service.open({ ...g.openOptions, ownerId: 'wxid_explicit_cached_owner' })
  await g.service.close({ connectionId: catalog.connectionId })
  const retry = await g.service.autoSetup({ accountPath: path.join(g.accountPath, 'db_storage') + path.sep }, new AbortController().signal, () => {})
  assert.equal(retry.status, 'ready'); assert.equal(retry.configuration.ownerName, ownerName)
  assert.equal(retry.configuration.ownerId, 'wxid_explicit_cached_owner')
  assertNoConnections(f); assertNoConnections(g)
})

test('automatic fill reports denied or absent WeChat without returning unverified configuration', async t => {
  const f = fixture(t)
  for (const [processes, denied, status] of [[1, true, 'permission'], [0, false, 'needs-wechat']]) {
    const result = await autoConfigure({ accountPath: f.accountPath }, { helperPath: '', signal: new AbortController().signal, progress() {}, scan: async () => ({ processes, denied, limited: false, candidates: [] }) })
    assert.equal(result.status, status); assert.equal(result.configuration, undefined)
    assert.equal(result.verifiedDatabases, 1)
  }
  const control = new AbortController(); control.abort()
  await assert.rejects(autoConfigure({ accountPath: f.accountPath }, { helperPath: '', signal: control.signal, progress() {} }), /取消/)
})

test('account discovery refuses a parent containing multiple accounts', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'wxid_second_account', 'db_storage'), { recursive: true })
  await assert.rejects(findSourceDatabases(f.root), /单个微信账号|单个账号/)
  const found = await findSourceDatabases(path.join(f.accountPath, 'db_storage'))
  assert.equal(found.root, f.accountPath)
  assert.equal(found.files.length, 3)
  assert.equal(isInside(f.accountPath, path.join(f.root, `${ownerId}-sibling/file.db`)), false)
})

test('reopening the same page releases its orphaned worker and snapshots', async t => {
  const f = fixture(t)
  const first = await f.service.open({ ...f.openOptions, clientId: 'synthetic-page' })
  const second = await f.service.open({ ...f.openOptions, clientId: 'synthetic-page' })
  assert.notEqual(first.connectionId, second.connectionId)
  await assert.rejects(f.service.load(loadOptions(first), new AbortController().signal, () => {}), /连接已关闭/)
  assert.equal(snapshotFiles(f).filter(file => file.endsWith('.db')).length, 2)
  const dataset = await f.service.load(loadOptions(second), new AbortController().signal, () => {})
  assert.equal(dataset.messages.length, 4)
})

test('local image decoder reads old XOR and AES/XOR DAT without a plugin', () => {
  const oldDat = Buffer.from(png)
  for (let i = 0; i < oldDat.length; i++) oldDat[i] = png[i] ^ 83
  assert.equal(decodeLocalImage(oldDat).dataUrl, `data:image/png;base64,${png.toString('base64')}`)
  const header = Buffer.alloc(15)
  Buffer.from('070856320807', 'hex').copy(header)
  header.writeUInt32LE(24, 6); header.writeUInt32LE(15, 10)
  const aes = crypto.createCipheriv('aes-128-ecb', Buffer.from(imageKey), null)
  const encrypted = Buffer.concat([aes.update(png.subarray(0, 24)), aes.final()])
  const tail = Buffer.from(png.subarray(-15))
  for (let i = 0; i < tail.length; i++) tail[i] ^= 83
  const input = Buffer.concat([header, encrypted, png.subarray(24, -15), tail])
  assert.equal(decodeLocalImage(input, { imageKey, xorKey: 83 }).dataUrl, `data:image/png;base64,${png.toString('base64')}`)
  assert.throws(() => decodeLocalImage(input), /图片 AES 密钥/)
  assert.throws(() => decodeLocalImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /不支持|不匹配/)
})

test('real worker opens encrypted per-key databases, loads CaseDataset and resolves an MD5 PNG with no network service', { timeout: 20000 }, async t => {
  const f = fixture(t, { derivedMessages: true })
  const events = []
  const catalog = await f.service.open(f.openOptions, undefined, event => events.push(event))
  assert.equal(typeof catalog.connectionId, 'string')
  assert.equal(catalog.ownerId, ownerId)
  assert.equal(catalog.databaseCount, 3)
  assert.deepEqual(catalog.sessions.map(session => session.id), [peerId])
  assert.equal(catalog.people.find(person => person.id === ownerId).name, ownerName)
  assert.equal(catalog.people.find(person => person.id === peerId).name, '合成好友备注')
  assert.equal(catalog.people.find(person => person.id === peerId).alias, 'fixture-alias')
  assert.equal(snapshotFiles(f).filter(file => file.endsWith('.db')).length, 2, 'message snapshot is prepared lazily at load')
  const dataset = await f.service.load(loadOptions(catalog), new AbortController().signal, event => events.push(event))
  assert.equal(dataset.source, 'local')
  assert.equal(dataset.ownerId, ownerId)
  assert.equal(dataset.messages.length, 4)
  assert.deepEqual(dataset.messages.map(message => message.originalId), [firstServerId, selfServerId, imageServerId, unsignedServerId])
  assert.equal(dataset.messages[0].content, '我喜欢摄影和旧书店。')
  assert.equal(dataset.messages[0].senderId, peerId)
  assert.equal(dataset.messages[1].senderId, ownerId)
  assert.equal(dataset.messages[1].senderName, ownerName)
  assert.equal(dataset.messages[1].replyTo, dataset.messages[0].id)
  assert.equal(dataset.messages[0].timestamp, timestamp * 1000)
  assert.equal(dataset.coverage.partial, false)
  assert.equal(dataset.coverage.messageCount, 4)
  assert.ok(events.some(event => event.messages === 4))
  assert.equal(snapshotFiles(f).filter(file => file.endsWith('.db')).length, 3)
  const serialized = JSON.stringify({ catalog, dataset })
  for (const secret of [contactKey, messageKey, imageKey, f.keysJSON]) assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('https://never-request.invalid'), false)
  const image = dataset.messages.find(message => message.kind === 'image')
  assert.ok(image)
  assert.equal(image.mediaKey, `image:${mediaMd5}`)
  assert.deepEqual(await f.service.media({ connectionId: catalog.connectionId, evidence: image }), { dataUrl: `data:image/png;base64,${png.toString('base64')}` })
  // Renderer-supplied fields cannot redirect a media request away from the
  // worker's evidence record: only the already-loaded ID is accepted.
  assert.deepEqual(await f.service.media({ connectionId: catalog.connectionId, evidence: { ...image, mediaKey: 'image:' + 'f'.repeat(32), mediaUrl: 'http://untrusted.invalid/' } }), { dataUrl: `data:image/png;base64,${png.toString('base64')}` })
  await assert.rejects(f.service.media({ connectionId: catalog.connectionId, evidence: { ...image, id: 'not-loaded' } }), /重新读取/)
  assertOriginals(f)
  await f.service.close({ connectionId: catalog.connectionId })
  assertNoConnections(f)
  await assert.rejects(f.service.load(loadOptions(catalog), new AbortController().signal, () => {}), /已关闭/)
  await f.service.close({ connectionId: catalog.connectionId })
  assertOriginals(f)
})

test('missing and wrong catalog keys reject without leaving private snapshots or leaking keys', { timeout: 20000 }, async t => {
  const f = fixture(t)
  for (const bad of ['', incorrectKey]) {
    await assert.rejects(f.service.open({ ...f.openOptions, key: bad }), error => {
      assert.match(error.message, /联系人或会话数据库未能打开/)
      assert.equal(error.message.includes(contactKey), false)
      assert.equal(error.message.includes(messageKey), false)
      assert.equal(error.message.includes(incorrectKey), false)
      return true
    })
    assertNoConnections(f)
    assertOriginals(f)
  }
  await assert.rejects(f.service.open({ ...f.openOptions, key: undefined }), /密钥应为/)
  assertNoConnections(f)
})

test('wrong per-database message key cleans its failed output and close removes catalog snapshots', { timeout: 20000 }, async t => {
  const f = fixture(t)
  const catalog = await f.service.open({ ...f.openOptions, keys: JSON.parse(JSON.stringify({ 'db_storage/message/message_0.db': incorrectKey })) })
  const catalogFiles = snapshotFiles(f)
  assert.equal(catalogFiles.length, 2)
  await assert.rejects(f.service.load(loadOptions(catalog), new AbortController().signal, () => {}), error => {
    assert.match(error.message, /没有成功打开消息数据库/)
    assert.equal(error.message.includes(incorrectKey), false)
    return true
  })
  assert.deepEqual(snapshotFiles(f), catalogFiles)
  await f.service.close({ connectionId: catalog.connectionId })
  assertNoConnections(f)
  assertOriginals(f)
})

test('legacy HTTP options are rejected by the local service contract', { timeout: 20000 }, async t => {
  const f = fixture(t)
  const legacy = { baseUrl: 'http://127.0.0.1:5031', token: 'synthetic-http-token' }
  await assert.rejects(f.service.open(legacy), /请选择微信账号资料目录/)
  await assert.rejects(f.service.load({ ...legacy, sessionIds: [peerId], maxMessages: 0, ownerName }, new AbortController().signal, () => {}), /先打开本机微信资料/)
  await assert.rejects(f.service.media({ ...legacy, evidence: { id: 'legacy-id' } }), /先打开本机微信资料/)
  assertNoConnections(f)
  assertOriginals(f)
})

test('cancelled open and active decryption clean partial snapshots; retry can complete', { timeout: 20000 }, async t => {
  const f = fixture(t, { derivedMessages: true, extraMessages: 1050 })
  const preCancelled = new AbortController()
  preCancelled.abort()
  await assert.rejects(f.service.open(f.openOptions, preCancelled.signal), /取消/)
  assertNoConnections(f)
  const catalog = await f.service.open(f.openOptions)
  const catalogFiles = snapshotFiles(f)
  const control = new AbortController()
  let cancelled = false
  await assert.rejects(f.service.load(loadOptions(catalog), control.signal, event => {
    if (!cancelled && event.sessionName.startsWith('校验并解密')) { cancelled = true; control.abort() }
  }), /取消/)
  assert.equal(cancelled, true, 'abort must happen during a real worker operation')
  assert.deepEqual(snapshotFiles(f), catalogFiles, 'cancelled decrypted message output must be removed')
  const result = await f.service.load(loadOptions(catalog), new AbortController().signal, () => {})
  assert.equal(result.messages.length, 1054)
  assert.equal(result.coverage.partial, false)
  await f.service.close({ connectionId: catalog.connectionId })
  assertNoConnections(f)
  assertOriginals(f)
})

test('salt-key lookup, message limits, and closing an active worker retain explicit coverage and clean snapshots', { timeout: 20000 }, async t => {
  const f = fixture(t, { extraMessages: 1050 })
  const catalog = await f.service.open({ ...f.openOptions, keys: JSON.parse(JSON.stringify({ [f.salt]: messageKey })) })
  const limited = await f.service.load(loadOptions(catalog, 505), new AbortController().signal, () => {})
  assert.equal(limited.messages.length, 505)
  assert.equal(limited.coverage.partial, true)
  assert.ok(limited.coverage.warnings.some(warning => warning.includes('505')))
  const pending = f.service.load(loadOptions(catalog), new AbortController().signal, () => {})
  const rejection = assert.rejects(pending, /已关闭|已停止/)
  await f.service.close({ connectionId: catalog.connectionId })
  await rejection
  assertNoConnections(f)
  assertOriginals(f)
})

test('reverse-ordered generic keys authenticate every separately encrypted database, including derived secrets', { timeout: 30000 }, async t => {
  for (const derived of [false, true]) {
    const f = fixture(t, { derivedMessages: derived })
    const sessionKey = crypto.createHash('sha256').update('synthetic-session-key').digest('hex')
    const sessionPlain = path.join(f.root, 'seed-session.db')
    database(sessionPlain, 80, db => {
      db.exec('CREATE TABLE SessionTable(username TEXT, sort_timestamp INTEGER, summary TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES(?,?,?)').run(peerId, timestamp, '合成会话')
    })
    encryptSqlCipher4(sessionPlain, path.join(f.accountPath, 'db_storage/session/session.db'), sessionKey, derived)
    if (derived) encryptSqlCipher4(path.join(f.root, 'seed-contact.db'), path.join(f.accountPath, 'db_storage/contact/contact.db'), contactKey, true)
    f.originals = originalBytes(f.accountPath)
    const result = await autoConfigure({ accountPath: f.accountPath }, {
      helperPath: '', signal: new AbortController().signal, progress() {},
      scan: async () => ({ processes: 1, denied: false, limited: false, candidates: [{ key: messageKey }, { key: sessionKey }, { key: contactKey }] }),
    })
    assert.equal(result.status, 'ready'); assert.equal(result.verifiedDatabases, 3)
    assert.equal(result.configuration.keys['db_storage/session/session.db'], sessionKey)
    assert.equal(result.configuration.keys['db_storage/message/message_0.db'], messageKey)
    const catalog = await f.service.open(result.configuration)
    assert.equal((await f.service.load(loadOptions(catalog), new AbortController().signal, () => {})).messages.length, 4)
    assertOriginals(f)
  }
})

test('service disposal cancels auto jobs, awaits cleanup, and terminates an unresponsive worker', { timeout: 10000 }, async () => {
  for (const responsive of [true, false]) {
    const dataRoot = path.join(suiteRoot, `dispose-auto-${responsive}`)
    const workerPath = path.join(suiteRoot, `dispose-auto-${responsive}.cjs`)
    fs.writeFileSync(workerPath, `const { parentPort } = require('node:worker_threads'); let id; parentPort.on('message', value => { if (value.action === 'auto-setup') { id = value.id; parentPort.postMessage({ progress: { sessionName: 'synthetic job active', sessionsDone: 0, sessionsTotal: 0, messages: 0 } }); } else if (value.action === 'cancel' && ${responsive}) parentPort.postMessage({ id, error: '自动识别已取消' }); }); setInterval(() => {}, 1000);`)
    const service = new NativeArchiveService({ workerPath, dataRoot, documents: path.join(suiteRoot, 'empty-documents'), profileOptions: { configPaths: [] } })
    let began
    const started = new Promise(resolve => { began = resolve })
    const pending = service.autoSetup({}, new AbortController().signal, () => began())
    const rejected = assert.rejects(pending, /取消|停止/)
    await started
    await service.dispose()
    await rejected
    assertNoConnections({ dataRoot })
    await assert.rejects(service.autoSetup({}, new AbortController().signal, () => {}), /服务已关闭/)
  }
})

test('saved WeFlow root discovery finds moved accounts and excludes empty leftover folders', async t => {
  const f = fixture(t)
  const profile = path.join(f.root, 'saved-profile.json'), documents = path.join(f.root, 'documents')
  fs.writeFileSync(profile, JSON.stringify({ dbPath: f.root, myWxid: ownerId, decryptKey: 'safe:not-decoded-during-discovery' }))
  fs.mkdirSync(path.join(documents, 'WeChat Files/wxid_empty/db_storage'), { recursive: true })
  const discovery = await discoverAccounts({ documents, home: path.join(f.root, 'home'), profileOptions: { configPaths: [profile] } })
  assert.deepEqual(discovery.accounts.map(account => account.path), [f.accountPath])
  assert.equal(discovery.searched[0], f.root)
  const selection = await autoConfigure({ accountPath: f.root }, { helperPath: '', signal: new AbortController().signal, progress() {}, profileOptions: { configPaths: [] }, scan: async () => { throw new Error('a parent-directory choice must not read any process') } })
  assert.equal(selection.status, 'select-account')
  assert.deepEqual(selection.accounts.map(account => account.path), [f.accountPath])
  assertOriginals(f)
})

test('service restores a saved protected WeFlow key and authenticates it before filling without a WeFlow server', { timeout: 20000 }, async t => {
  const f = fixture(t)
  encryptSqlCipher4(path.join(f.root, 'seed-message.db'), path.join(f.accountPath, 'db_storage/message/message_0.db'), contactKey, true)
  f.originals = originalBytes(f.accountPath)
  const profile = path.join(f.root, 'saved-profile.json')
  const protectedText = 'synthetic protected DB key'
  fs.writeFileSync(profile, JSON.stringify({ dbPath: f.root, myWxid: ownerId, decryptKey: 'safe:' + Buffer.from(protectedText).toString('base64') }))
  const dataRoot = path.join(f.root, 'profile-runtime')
  let decryptions = 0
  const service = new NativeArchiveService({ workerPath: path.join(compiledRoot, 'native-worker.js'), dataRoot, documents: path.join(f.root, 'empty-documents'), profileOptions: { configPaths: [profile] }, decryptProtected: ciphertext => { decryptions++; assert.equal(ciphertext.toString(), protectedText); return contactKey } })
  t.after(async () => { await service.dispose(); assertNoConnections({ dataRoot }) })
  const events = []
  const result = await service.autoSetup({}, new AbortController().signal, value => events.push(value))
  assert.equal(result.status, 'ready'); assert.equal(result.verifiedDatabases, 3)
  assert.match(result.message, /本机保存的连接设置/)
  assert.equal(result.configuration.key, contactKey); assert.equal(result.configuration.ownerId, ownerId)
  assert.equal(decryptions, 1)
  assert.equal(JSON.stringify(events).includes(contactKey), false)
  const catalog = await service.open(result.configuration)
  assert.equal((await service.load(loadOptions(catalog), new AbortController().signal, () => {})).messages.length, 4)
  assertOriginals(f)
})

test('unverified saved keys are rejected, and a different Windows account gets an actionable permission reason', async t => {
  const f = fixture(t)
  const result = await autoConfigure({ accountPath: f.accountPath }, {
    helperPath: '', signal: new AbortController().signal, progress() {}, profileOptions: { configPaths: [] },
    profile: { candidates: [{ key: incorrectKey }], ownerId: 'wrong-owner', warnings: [] },
    scan: async () => ({ processes: 1, denied: true, limited: false, identityMismatch: true, candidates: [] }),
  })
  assert.equal(result.status, 'permission'); assert.equal(result.configuration, undefined)
  assert.match(result.message, /不同的 Windows 用户/)
  assert.equal(result.message.includes(incorrectKey), false)
  assertOriginals(f)
})

test('a failed scanner retains authenticated saved catalog keys as partial instead of discarding the configuration', async t => {
  const f = fixture(t)
  const result = await autoConfigure({ accountPath: f.accountPath }, {
    helperPath: '', signal: new AbortController().signal, progress() {}, profileOptions: { configPaths: [] },
    profile: { candidates: [{ key: contactKey }], ownerId, warnings: [] },
    scan: async () => { throw new Error('synthetic scanner failure ' + incorrectKey) },
  })
  assert.equal(result.status, 'partial'); assert.equal(result.verifiedDatabases, 2)
  assert.equal(result.configuration.key, contactKey)
  assert.equal(result.configuration.keys['db_storage/message/message_0.db'], undefined)
  assert.match(result.warnings.join(' '), /扫描未能完成/)
  assert.equal(JSON.stringify(result.warnings).includes(incorrectKey), false)
  assertOriginals(f)
})
function syntheticDat(xor = 83) {
  const header = Buffer.alloc(15)
  Buffer.from('070856320807', 'hex').copy(header)
  header.writeUInt32LE(24, 6); header.writeUInt32LE(15, 10)
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(imageKey), null)
  const encrypted = Buffer.concat([cipher.update(png.subarray(0, 24)), cipher.final()])
  const tail = Buffer.from(png.subarray(-15))
  for (let index = 0; index < tail.length; index++) tail[index] ^= xor
  return Buffer.concat([header, encrypted, png.subarray(24, -15), tail])
}
test('image parameters require valid AES and a consistent image trailer; missing XOR is derived and zero is retained', () => {
  for (const xor of [0, 83, 255]) {
    const input = syntheticDat(xor)
    assert.deepEqual(verifyImageCandidate(input, { imageKey }), { imageKey, xorKey: xor })
    assert.equal(verifyImageCandidate(input, { imageKey: 'WrongImageKey_16' }), undefined)
    assert.equal(verifyImageCandidate(input, { imageKey, xorKey: xor ^ 1 }), undefined)
    const damaged = Buffer.from(input); damaged[damaged.length - 1] ^= 1
    assert.equal(verifyImageCandidate(damaged, { imageKey }), undefined)
  }
})
test('automatic connection independently validates saved account image parameters and does not export or log secrets', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.accountPath, 'all_keys.json'), JSON.stringify({ 'contact.db': contactKey, 'message_0.db': messageKey }))
  const file = path.join(f.accountPath, 'msg/attach/synthetic/image', 'validated.dat')
  fs.writeFileSync(file, syntheticDat(0))
  fs.writeFileSync(path.join(f.accountPath, 'image_keys.json'), JSON.stringify({ imageAesKey: imageKey }))
  const before = fs.readFileSync(file), events = []
  const result = await autoConfigure({ accountPath: f.accountPath }, { helperPath: '', signal: new AbortController().signal, progress: value => events.push(value), scan: async () => { throw new Error('already validated') } })
  assert.equal(result.status, 'ready')
  assert.equal(result.configuration.imageKey, imageKey)
  assert.equal(result.configuration.xorKey, 0)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(JSON.stringify(events).includes(imageKey), false)
  const invalid = await discoverImageKeys(f.accountPath, [{ imageKey: 'WrongImageKey_16' }], new AbortController().signal)
  assert.equal(invalid.configuration.imageKey, imageKey, 'the account-local image key is validated after the invalid supplied key')
  const control = new AbortController(); control.abort()
  await assert.rejects(discoverImageKeys(f.accountPath, [{ imageKey }], control.signal), /取消/)
})
