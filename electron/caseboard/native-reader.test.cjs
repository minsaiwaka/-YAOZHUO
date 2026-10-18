// Synthetic databases only: node --test electron/caseboard/native-reader.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { zstdCompressSync } = require('node:zlib')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.join(__dirname, 'native-reader.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const isolated = new Module(filename, module)
isolated.filename = filename
isolated.paths = Module._nodeModulePaths(__dirname)
isolated._compile(compiled, filename)
const { NativeReader } = isolated.exports
const md5 = value => createHash('md5').update(value).digest('hex')
const owner = 'wxid_test_owner'
const peer = 'wxid_test_peer'
const room = 'synthetic-test@chatroom'
const options = { ownerId: owner, ownerName: '测试本机用户' }
const baseTime = 1756684800

function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'yaozhuo-reader-')
  const folder = fs.mkdtempSync(prefix)
  const readers = []
  t.after(() => {
    for (const reader of readers) reader.close()
    const absolute = path.resolve(folder)
    assert.ok(absolute.startsWith(path.resolve(prefix)))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  function database(name, kind, prepare) {
    const snapshotPath = path.join(folder, name)
    const database = new DatabaseSync(snapshotPath)
    try { prepare(database) } finally { database.close() }
    return { sourcePath: path.join(folder, 'NEVER_READ_SOURCE', name), snapshotPath, relativePath: name, kind }
  }
  function reader(files, opts = options) { const instance = new NativeReader(files, opts); readers.push(instance); return instance }
  return { folder, database, reader }
}
function catalogFiles(f) {
  const contacts = f.database('contact.db', 'contact', db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT, alias TEXT, local_type INTEGER)')
    const put = db.prepare('INSERT INTO contact VALUES(?,?,?,?,?)')
    put.run(owner, '自己的昵称', '', '', 1)
    put.run(peer, '林知夏', '旧备注知夏', 'linxia', 1)
    put.run(room, '合成测试群', '', '', 2)
  })
  const sessions = f.database('session.db', 'session', db => {
    db.exec('CREATE TABLE SessionTable(username TEXT, sort_timestamp INTEGER, summary TEXT)')
    const put = db.prepare('INSERT INTO SessionTable VALUES(?,?,?)')
    put.run(peer, baseTime, '合成私聊'); put.run(room, baseTime, '合成群聊')
  })
  const groups = f.database('group.db', 'group', db => {
    db.exec('CREATE TABLE chatroom(chatroomname TEXT, memberlist TEXT)')
    db.prepare('INSERT INTO chatroom VALUES(?,?)').run(room, `${owner}\u0007${peer}\u0007wxid_test_member`)
  })
  return [contacts, sessions, groups]
}
function createMessageTable(db, session, extra = '') {
  const name = 'Msg_' + md5(session)
  db.exec(`CREATE TABLE "${name}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,compress_content BLOB,source TEXT${extra})`)
  return db.prepare(`INSERT INTO "${name}" VALUES(?,?,?,?,?,?,?,?${extra ? ',?' : ''})`)
}

test('真实联系人/会话/群名册读取，初始目录后再增量加入消息快照', async t => {
  const f = fixture(t), files = catalogFiles(f), reader = f.reader(files)
  const catalog = reader.catalog()
  assert.equal(catalog.people.find(person => person.id === owner).name, options.ownerName)
  assert.equal(catalog.people.find(person => person.id === peer).name, '旧备注知夏')
  assert.equal(catalog.people.find(person => person.id === peer).alias, 'linxia')
  assert.equal(catalog.sessions.length, 2)
  assert.equal(catalog.sessions.find(session => session.id === room).kind, 'group')
  assert.ok(catalog.memberships.some(item => item.personId === 'wxid_test_member' && item.groupId === room))
  const messages = f.database('message_0.db', 'message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)')
    const name = db.prepare('INSERT INTO Name2Id VALUES(?)'); name.run(owner); name.run(peer)
    const insert = createMessageTable(db, peer)
    insert.run(1, 9223372036854775805n, 1, baseTime, 2, '', zstdCompressSync(Buffer.from('我喜欢旧书店和摄影。')), '')
    insert.run(2, 9223372036854775806n, 49, baseTime + 1, 1, '<msg><appmsg><title>周末一起去</title><type>57</type><refermsg><svrid>9223372036854775805</svrid></refermsg></appmsg></msg>', null, `<msgsource><atuserlist><![CDATA[${peer}]]></atuserlist></msgsource>`)
    insert.run(3, 9007199254740993n, 3, baseTime + 2, 2, '<msg><img md5="abcdef0123456789abcdef0123456789" cdnthumburl="https://never-request.example/image" /></msg>', null, '')
  })
  const before = fs.readFileSync(messages.snapshotPath)
  reader.addMessageFiles([messages, messages])
  const progress = []
  const dataset = await reader.load([peer], 0, new AbortController().signal, event => progress.push(event))
  assert.equal(dataset.source, 'local')
  assert.equal(dataset.messages.length, 3)
  assert.equal(dataset.messages[0].originalId, '9223372036854775805')
  assert.equal(dataset.messages[0].content, '我喜欢旧书店和摄影。')
  assert.equal(dataset.messages[0].senderId, peer)
  assert.equal(dataset.messages[0].timestamp, baseTime * 1000)
  assert.equal(dataset.messages[1].replyTo, `${peer}:server:9223372036854775805`)
  assert.equal(dataset.messages[1].senderId, owner)
  assert.deepEqual(dataset.messages[1].mentionedIds, [peer])
  assert.equal(dataset.messages[2].mediaKey, 'image:abcdef0123456789abcdef0123456789')
  assert.equal(dataset.messages[2].mediaUrl, undefined)
  assert.equal(reader.getSourceRecord(dataset.messages[2].id).mediaMd5, 'abcdef0123456789abcdef0123456789')
  assert.equal(fs.existsSync(messages.sourcePath), false)
  assert.deepEqual(fs.readFileSync(messages.snapshotPath), before, 'snapshot must stay unchanged')
  assert.equal(progress.at(-1).sessionsDone, 1)
  assert.equal(dataset.coverage.partial, false)
})

test('long conversations execute the ordered message scan once and retain every tied timestamp and 64-bit ID', async t => {
  const f = fixture(t), reader = f.reader(catalogFiles(f))
  const count = 12000
  const file = f.database('long-conversation.db', 'message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)')
    db.prepare('INSERT INTO Name2Id VALUES(?)').run(peer)
    const insert = createMessageTable(db, peer)
    db.exec('BEGIN;')
    for (let index = 0; index < count; index++) insert.run(index + 1, 9223372036800000000n + BigInt(index), 1, baseTime + Math.floor(index / 4), 1, `長對話第 ${index} 條`, null, '')
    db.exec('COMMIT;')
  })
  reader.addMessageFiles([file])
  const originalPrepare = DatabaseSync.prototype.prepare
  let orderedScans = 0
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/ORDER BY.*create_time/i.test(sql)) orderedScans++
    return originalPrepare.call(this, sql, ...args)
  }
  let dataset
  try { dataset = await reader.load([peer], 0, new AbortController().signal, () => {}) }
  finally { DatabaseSync.prototype.prepare = originalPrepare }
  assert.equal(orderedScans, 1, 'SQLite must not rescan/sort a long conversation once per page')
  assert.equal(dataset.messages.length, count)
  assert.equal(new Set(dataset.messages.map(message => message.id)).size, count)
  for (let index = 0; index < count; index++) {
    assert.equal(dataset.messages[index].originalId, String(9223372036800000000n + BigInt(index)))
    assert.equal(dataset.messages[index].content, `長對話第 ${index} 條`)
  }
  assert.equal(dataset.coverage.partial, false)
})

test('不同数据库 Name2Id 隔离，重复 server ID 去重，未知发送者不会误认自己', async t => {
  const f = fixture(t), reader = f.reader(catalogFiles(f))
  const one = f.database('message_a.db', 'message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)'); db.prepare('INSERT INTO Name2Id VALUES(?)').run(peer)
    createMessageTable(db, peer).run(1, 12345678901234567n, 1, baseTime, 1, '第一份消息', null, '')
  })
  const duplicate = { ...one, snapshotPath: path.join(f.folder, 'message_duplicate.db'), relativePath: 'message_duplicate.db' }
  fs.copyFileSync(one.snapshotPath, duplicate.snapshotPath)
  const two = f.database('message_b.db', 'message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)'); db.prepare('INSERT INTO Name2Id VALUES(?)').run(owner)
    const insert = createMessageTable(db, peer)
    insert.run(1, 22345678901234567n, 1, baseTime + 1, 1, '第二个库的自己', null, '')
    insert.run(2, 32345678901234567n, 1, baseTime + 2, 999, '无法识别发送人', null, '')
  })
  reader.addMessageFiles([one, duplicate, two])
  const result = await reader.load([peer], 0, new AbortController().signal, () => {})
  assert.equal(result.messages.length, 3)
  assert.equal(result.messages[0].senderId, peer)
  assert.equal(result.messages[1].senderId, owner)
  assert.match(result.messages[2].senderId, /^unknown-sender:/)
  assert.notEqual(result.messages[2].senderId, owner)
  assert.ok(result.coverage.partial)
  assert.ok(result.coverage.warnings.some(warning => warning.includes('未将其推定为本机用户')))
})

test('Mac3 Contact / Session / Chat_md5 常见列与 mesDes 方向可读', async t => {
  const f = fixture(t)
  const contact = f.database('mac-contact.sqlite', 'contact', db => {
    db.exec('CREATE TABLE Contact(m_nsUsrName TEXT,m_nsNickName TEXT,m_nsRemark TEXT,m_nsAliasName TEXT)')
    db.prepare('INSERT INTO Contact VALUES(?,?,?,?)').run(peer, 'Mac好友', 'Mac备注', 'oldalias')
  })
  const session = f.database('mac-session.sqlite', 'session', db => {
    db.exec('CREATE TABLE Session(m_nsUsrName TEXT,m_nsDisplayName TEXT)')
    db.prepare('INSERT INTO Session VALUES(?,?)').run(peer, '显示名')
  })
  const message = f.database('mac-msg_0.db', 'message', db => {
    const name = 'Chat_' + md5(peer)
    db.exec(`CREATE TABLE "${name}"(mesLocalID INTEGER PRIMARY KEY,mesSvrID INTEGER,msgCreateTime INTEGER,msgContent TEXT,messageType INTEGER,mesDes INTEGER,CompressContent BLOB)`)
    const insert = db.prepare(`INSERT INTO "${name}" VALUES(?,?,?,?,?,?,?)`)
    insert.run(1, 42345678901234567n, baseTime, '我发出的消息', 1, 0, null)
    insert.run(2, 52345678901234567n, baseTime + 1, '对方发来的消息', 1, 1, null)
  })
  const reader = f.reader([contact, session, message])
  const catalog = reader.catalog()
  assert.equal(catalog.people.find(person => person.id === peer).name, 'Mac备注')
  const result = await reader.load([peer], 0, new AbortController().signal, () => {})
  assert.deepEqual(result.messages.map(message => message.senderId), [owner, peer])
  assert.deepEqual(result.messages.map(message => message.content), ['我发出的消息', '对方发来的消息'])
})

test('群成员仅从消息观察时明确标为不完整，坏压缩有警告并保留有效回退', async t => {
  const f = fixture(t), files = catalogFiles(f).filter(file => file.kind !== 'group'), reader = f.reader(files)
  const file = f.database('bad-compression.db', 'message', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT)'); db.prepare('INSERT INTO Name2Id VALUES(?)').run('wxid_observed_member')
    createMessageTable(db, room).run(1, 62345678901234567n, 1, baseTime, 1, '可读的原文字段', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]), '')
  })
  reader.addMessageFiles([file])
  const result = await reader.load([room], 0, new AbortController().signal, () => {})
  assert.equal(result.messages[0].content, '可读的原文字段')
  assert.ok(result.memberships.some(member => member.personId === 'wxid_observed_member' && member.groupId === room))
  assert.ok(result.coverage.warnings.some(warning => warning.includes('不是完整名册')))
  assert.ok(result.coverage.warnings.some(warning => warning.includes('解压或文字解码失败')))
  assert.equal(result.coverage.partial, true)
})

test('跨页读取、消息上限与取消都保留明确覆盖范围', async t => {
  const f = fixture(t), reader = f.reader(catalogFiles(f))
  const file = f.database('paged.db', 'message', db => {
    const insert = createMessageTable(db, peer, ',is_send INTEGER')
    db.exec('BEGIN')
    for (let index = 1; index <= 1050; index++) insert.run(index, BigInt(index), 1, baseTime + index, null, `合成消息 ${index}`, null, '', 1)
    db.exec('COMMIT')
  })
  reader.addMessageFiles([file])
  const events = []
  const limited = await reader.load([peer], 505, new AbortController().signal, event => events.push(event))
  assert.equal(limited.messages.length, 505)
  assert.ok(limited.coverage.partial)
  assert.ok(events.some(event => event.messages === 500))
  const cancelled = new AbortController(); cancelled.abort()
  const stopped = await reader.load([peer], 0, cancelled.signal, () => {})
  assert.equal(stopped.messages.length, 0)
  assert.ok(stopped.coverage.warnings.some(warning => warning.includes('停止')))
  const full = await reader.load([peer], 0, new AbortController().signal, () => {})
  assert.equal(full.messages.length, 1050)
  assert.equal(full.coverage.partial, false)
  assert.equal(full.coverage.warnings.some(warning => warning.includes('达到 505') || warning.includes('用户停止')), false)
  const midRead = new AbortController()
  const interrupted = await reader.load([peer], 0, midRead.signal, event => { if (event.messages >= 500) midRead.abort() })
  assert.equal(interrupted.messages.length, 500)
  assert.equal(interrupted.coverage.partial, true)
})

test('缺 schema、坏快照、空 owner 与关闭后的访问不会伪装为成功读取', async t => {
  const f = fixture(t)
  const unrecognized = f.database('unknown.db', 'message', db => db.exec('CREATE TABLE unknown_schema(unrelated TEXT)'))
  const missing = { ...unrecognized, snapshotPath: path.join(f.folder, 'missing.db'), relativePath: 'missing.db' }
  const reader = f.reader([unrecognized, missing])
  const catalog = reader.catalog()
  assert.ok(catalog.warnings.some(warning => warning.includes('无法只读打开')))
  assert.ok(catalog.warnings.some(warning => warning.includes('联系人表')))
  const result = await reader.load([peer], 0, new AbortController().signal, () => {})
  assert.equal(result.messages.length, 0)
  assert.ok(result.coverage.partial)
  assert.ok(result.coverage.warnings.some(warning => warning.includes('没有可读取的消息表')))
  assert.throws(() => f.reader([], { ownerId: '', ownerName: '我' }), /账号 ID/)
  reader.close(); reader.close()
  assert.throws(() => reader.catalog(), /已关闭/)
})
