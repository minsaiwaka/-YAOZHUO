import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { inflateSync, zstdDecompressSync } from 'node:zlib'
import type { CaseDataset, Evidence, Membership, MessageKind, Person, WeFlowSession } from '../../src/caseboard/types'

export interface NativeDatabaseFile {
  sourcePath: string
  snapshotPath: string
  kind: 'contact' | 'session' | 'message' | 'group'
  relativePath: string
}
export interface NativeSourceRecord {
  sourcePath: string
  snapshotPath: string
  relativePath: string
  tableName: string
  localId: string
  serverId: string
  sessionId: string
  rawContent: string
  mediaMd5?: string
  mediaFileName?: string
}
type Row = Record<string, unknown>
type Table = { name: string; columns: Map<string, string>; withoutRowid: boolean }
type OpenFile = { file: NativeDatabaseFile; db: DatabaseSync; tables: Table[]; senderNames: Map<string, string> }
type MessageTable = { source: OpenFile; table: Table; sessionId?: string; sessionColumn?: string }
type Progress = { sessionsDone: number; sessionsTotal: number; messages: number; sessionName: string }
const PAGE_SIZE = 500
const MAX_CONTENT = 8 * 1024 * 1024
const normalizedKeys = new Map<string, string>()
const key = (value: string) => {
  let result = normalizedKeys.get(value)
  if (result === undefined) {
    result = value.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalizedKeys.size < 8192) normalizedKeys.set(value, result)
  }
  return result
}
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'bigint' || typeof value === 'number' ? String(value) : ''
const normalizedRows = new WeakMap<Row, Map<string, unknown>>()
const first = (row: Row, names: string[]): unknown => {
  let values = normalizedRows.get(row)
  if (!values) { values = new Map(Object.entries(row).map(([name, value]) => [key(name), value])); normalizedRows.set(row, values) }
  for (const name of names) { const value = values.get(key(name)); if (value !== undefined && value !== null && value !== '') return value }
  return undefined
}
const column = (table: Table, names: string[]) => names.map(name => table.columns.get(key(name))).find(Boolean)
const integer = (value: unknown): number | undefined => {
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value)) { const number = Number(value); if (Number.isSafeInteger(number)) return number }
  return undefined
}
const serverIdString = (value: unknown) => {
  const token = string(value)
  if (!/^-?\d+$/.test(token)) return token
  try { return BigInt.asUintN(64, BigInt(token)).toString() } catch { return '' }
}
const hash = (value: string) => createHash('md5').update(value).digest('hex')
const groupId = (value: string) => /@chatroom$/i.test(value)
const USER_COLUMNS = ['username', 'user_name', 'userName', 'usrName', 'm_nsUsrName', 'm_nsUserName', 'strTalker', 'talker', 'chatName', 'session_id', 'sessionId']
const NAME_COLUMNS = ['remark', 'conRemark', 'm_nsRemark', 'displayName', 'display_name', 'nick_name', 'nickname', 'nickName', 'm_nsNickName', 'm_nsDisplayName', 'name']
const CONTENT_COLUMNS = ['message_content', 'msgContent', 'strContent', 'Message', 'content', 'WCDB_CT_message_content']
const TIME_COLUMNS = ['create_time', 'createTime', 'msgCreateTime', 'MesTime', 'msg_time', 'time', 'timestamp']
const LOCAL_COLUMNS = ['local_id', 'localId', 'mesLocalID', 'msgLocalID', 'messageId', 'id']
const TYPE_COLUMNS = ['local_type', 'localType', 'messageType', 'MesType', 'Type', 'WCDB_CT_local_type']

function entities(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[\da-f]+|\d+);/gi, (_match, token: string) => {
    const point = token[0].toLowerCase() === 'x' ? parseInt(token.slice(1), 16) : parseInt(token, 10)
    return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : '�'
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
function xmlTag(xml: string, tag: string): string {
  const found = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return found ? entities(found[1]).trim() : ''
}
function xmlAttribute(xml: string, name: string): string {
  return entities(new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(xml)?.[1] || '')
}

/** Reads only decrypted snapshots supplied by the parent worker. No source file is opened. */
export class NativeReader {
  private readonly opened = new Map<string, OpenFile>()
  private readonly people = new Map<string, Person>()
  private readonly sessions = new Map<string, WeFlowSession>()
  private readonly memberPairs = new Map<string, Membership>()
  private readonly rosterGroups = new Set<string>()
  private readonly warningSet = new Set<string>()
  private readonly records = new Map<string, NativeSourceRecord>()
  private readonly datasetId: string
  private closed = false
  private incomplete = false
  private loadWarnings: Set<string> | undefined
  private loadIncomplete = false
  private loading = false
  private contactTables = 0
  private sessionTables = 0

  constructor(files: NativeDatabaseFile[], private readonly options: { ownerId: string; ownerName: string }) {
    if (!options.ownerId?.trim()) throw new Error('必须明确提供本机微信账号 ID，不能猜测消息发送人。')
    this.options = { ownerId: options.ownerId.trim(), ownerName: options.ownerName?.trim() || '我' }
    this.people.set(this.options.ownerId, { id: this.options.ownerId, name: this.options.ownerName, kind: 'self' })
    this.datasetId = `local-${createHash('sha256').update(this.options.ownerId + '\0' + files.map(file => file.sourcePath).sort().join('\0')).digest('hex').slice(0, 20)}`
    this.addFiles(files)
  }

  private warn(message: string, partial = true) {
    const warnings = this.loadWarnings || this.warningSet
    if (warnings.size < 200) warnings.add(message)
    else warnings.add('另有更多读取异常，当前资料不能视为完整。')
    if (partial) {
      if (this.loadWarnings) this.loadIncomplete = true
      else this.incomplete = true
    }
  }
  private ensureOpen() { if (this.closed) throw new Error('本地数据库连接已关闭。') }
  private query(source: OpenFile, sql: string, parameters: (string | number | bigint)[] = []): Row[] {
    const statement = source.db.prepare(sql)
    statement.setReadBigInts(true)
    return statement.all(...parameters) as Row[]
  }
  private person(id: string, name = '', alias = '', kind?: Person['kind']): Person {
    const existing = this.people.get(id)
    const personKind = id === this.options.ownerId ? 'self' : kind ?? (groupId(id) ? 'group' : existing?.kind ?? 'person')
    if (existing && personKind === existing.kind && (!name || name === id || name === existing.name) && (!alias || alias === existing.alias)) return existing
    const person: Person = { id, name: id === this.options.ownerId ? this.options.ownerName : (name && name !== id ? name : existing?.name || name || id), kind: personKind, ...((alias || existing?.alias) ? { alias: alias || existing?.alias } : {}) }
    this.people.set(id, person)
    return person
  }
  private session(id: string, name = '') {
    if (!id) return
    const person = this.person(id, name)
    this.sessions.set(id, { id, name: name || person.name, kind: person.kind === 'group' ? 'group' : 'private' })
  }
  private membership(personId: string, roomId: string) {
    if (!personId || !roomId || personId === roomId || groupId(personId)) return
    const pair = JSON.stringify([personId, roomId])
    if (this.memberPairs.has(pair)) return
    this.person(personId)
    this.person(roomId, '', '', 'group')
    this.memberPairs.set(pair, { personId, groupId: roomId })
  }

  private addFiles(files: NativeDatabaseFile[]) {
    this.ensureOpen()
    const added: OpenFile[] = []
    for (const file of files) {
      if (this.opened.has(file.snapshotPath)) continue
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(file.snapshotPath, { readOnly: true, allowExtension: false })
        db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
        const source: OpenFile = { file: { ...file }, db, tables: [], senderNames: new Map() }
        source.tables = this.query(source, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => {
          const name = string(row.name)
          const schema = this.query(source, `PRAGMA table_info(${quote(name)})`)
          return { name, columns: new Map(schema.map(item => [key(string(item.name)), string(item.name)])), withoutRowid: /WITHOUT\s+ROWID/i.test(string(row.sql)) }
        })
        this.opened.set(file.snapshotPath, source)
        added.push(source)
      } catch {
        try { db?.close() } catch { /* An invalid snapshot is never retried against the source. */ }
        this.warn(`无法只读打开数据库快照：${file.relativePath}。该库未被纳入分析。`)
      }
    }
    // All contacts are established before rooms and hashed message tables are resolved.
    for (const source of added) this.readContacts(source)
    for (const source of added) { this.readSessions(source); this.readMemberships(source); this.readName2Id(source) }
  }

  addMessageFiles(files: NativeDatabaseFile[]): void { this.addFiles(files) }

  private readRows(source: OpenFile, table: Table, callback: (rows: Row[]) => void) {
    const statement = source.db.prepare(`SELECT * FROM ${quote(table.name)}`)
    statement.setReadBigInts(true)
    let rows: Row[] = []
    for (const row of statement.iterate() as Iterable<Row>) {
      rows.push(row)
      if (rows.length === PAGE_SIZE) { callback(rows); rows = [] }
    }
    if (rows.length) callback(rows)
  }
  private readContacts(source: OpenFile) {
    for (const table of source.tables) {
      if (!/contact|rcontact/i.test(table.name) || /label|head|avatar|member|room/i.test(table.name) || !column(table, USER_COLUMNS)) continue
      try {
        this.contactTables++
        this.readRows(source, table, rows => {
          for (const row of rows) {
            const id = string(first(row, USER_COLUMNS))
            if (!id || id.length > 1024) continue
            const name = string(first(row, NAME_COLUMNS)) || id
            const alias = string(first(row, ['alias', 'm_nsAliasName', 'm_nsAlias', 'AliasName']))
            this.person(id, name, alias)
          }
        })
      } catch { this.warn(`联系人表读取失败：${source.file.relativePath} / ${table.name}。`) }
    }
  }
  private readSessions(source: OpenFile) {
    for (const table of source.tables) {
      if (!/session|conversation/i.test(table.name) || !column(table, USER_COLUMNS)) continue
      try {
        this.sessionTables++
        this.readRows(source, table, rows => {
          for (const row of rows) {
            const id = string(first(row, USER_COLUMNS))
            if (id && id.length <= 1024) this.session(id, this.people.get(id)?.name || string(first(row, NAME_COLUMNS)))
          }
        })
      } catch { this.warn(`会话表读取失败：${source.file.relativePath} / ${table.name}。`) }
    }
  }
  private readMemberships(source: OpenFile) {
    const roomColumns = ['chatroom_id', 'chatroomname', 'chatroom_name', 'room_id', 'roomName', 'group_id', 'group_username', 'm_nsChatRoomName', 'm_nsRoomName']
    for (const table of source.tables) {
      if (!/chatroom|chat_room|group|room.*member/i.test(table.name)) continue
      const roomColumn = column(table, roomColumns)
      if (!roomColumn && !column(table, USER_COLUMNS)) continue
      try {
        this.readRows(source, table, rows => {
          for (const row of rows) {
            const roomId = string(first(row, roomColumns)) || string(first(row, USER_COLUMNS))
            if (!roomId || (!groupId(roomId) && !this.people.has(roomId))) continue
            this.person(roomId, '', '', 'group')
            const single = string(first(row, ['member_username', 'member_user_name', 'memberName', 'm_nsMemberName', ...(roomColumn ? ['username', 'user_name', 'm_nsUsrName'] : [])]))
            if (single && single !== roomId) { this.membership(single, roomId); this.rosterGroups.add(roomId) }
            const rawList = first(row, ['member_list', 'memberlist', 'members', 'm_nsChatRoomMemList', 'm_nsMemberList', 'chatroom_member_list'])
            if (typeof rawList !== 'string' || !rawList.trim()) continue
            let memberList: string[]
            if (rawList.trim().startsWith('[')) {
              try {
                const parsed: unknown = JSON.parse(rawList)
                memberList = Array.isArray(parsed) ? parsed.map(item => typeof item === 'string' ? item.trim() : item && typeof item === 'object' ? string(first(item as Row, USER_COLUMNS)) : '').filter(Boolean) : []
              } catch { this.warn(`群「${roomId}」成员列表格式无法解析，未猜测成员身份。`); continue }
            } else memberList = rawList.includes('<')
              ? [...rawList.matchAll(/<(?:username|UserName)>([\s\S]*?)<\/(?:username|UserName)>/g)].map(match => entities(match[1]).trim())
              : rawList.replace(/\^G/g, '\u0007').split(/[\u0007,;|\r\n\s]+/).map(value => value.trim())
            for (const member of memberList.filter(Boolean)) this.membership(member, roomId)
            if (memberList.some(Boolean)) this.rosterGroups.add(roomId)
          }
        })
      } catch { this.warn(`群成员名册读取失败：${source.file.relativePath} / ${table.name}。`) }
    }
  }
  private readName2Id(source: OpenFile) {
    for (const table of source.tables) {
      const nameColumn = column(table, ['user_name', 'username', 'm_nsUsrName'])
      if (!/^name2id/i.test(table.name) || !nameColumn) continue
      try {
        const idColumn = column(table, ['id', 'name_id', 'user_id'])
        const idExpression = table.withoutRowid && idColumn ? quote(idColumn) : 'rowid'
        const statement = source.db.prepare(`SELECT ${idExpression} AS __sender_id, ${quote(nameColumn)} AS __username FROM ${quote(table.name)}`)
        statement.setReadBigInts(true)
        for (const row of statement.iterate() as Iterable<Row>) {
          const id = string(row.__sender_id), username = string(row.__username)
          if (id && username) source.senderNames.set(id, username)
        }
      } catch { this.warn(`发送者映射表读取失败：${source.file.relativePath} / ${table.name}。未知发送者会保留为未知。`) }
    }
  }

  private messageTables(): MessageTable[] {
    const tables: MessageTable[] = []
    const hashes = new Map<string, Set<string>>()
    for (const id of new Set([...this.people.keys(), ...this.sessions.keys()])) {
      const digest = hash(id)
      for (const candidate of [digest, digest.slice(0, 16)]) {
        if (!hashes.has(candidate)) hashes.set(candidate, new Set())
        hashes.get(candidate)!.add(id)
      }
    }
    for (const source of this.opened.values()) {
      if (source.file.kind !== 'message') continue
      let recognized = 0
      for (const table of source.tables) {
        if (!column(table, CONTENT_COLUMNS) || !column(table, TIME_COLUMNS)) continue
        const sessionColumn = column(table, ['session_id', 'sessionId', 'talker', 'strTalker', 'chat_username', 'chatUserName', 'chatName'])
        const match = /^(?:msg|chat)_([a-f\d]{16,32})(?:_|$)/i.exec(table.name)
        if (!match && !sessionColumn) continue
        if (!column(table, TYPE_COLUMNS)) { this.warn(`消息表缺少类型字段：${source.file.relativePath} / ${table.name}。`); continue }
        if (sessionColumn) {
          try {
            for (const row of this.query(source, `SELECT DISTINCT ${quote(sessionColumn)} AS __session FROM ${quote(table.name)}`)) this.session(string(row.__session))
          } catch { this.warn(`无法识别消息表的会话：${source.file.relativePath} / ${table.name}。`); continue }
          tables.push({ source, table, sessionColumn }); recognized++; continue
        }
        const digest = match![1].toLowerCase()
        const matches = hashes.get(digest) ?? (digest.length > 16 ? hashes.get(digest.slice(0, 16)) : undefined)
        if (matches && matches.size > 1) { this.warn(`消息表的会话哈希存在歧义：${source.file.relativePath} / ${table.name}，未进行猜测匹配。`); continue }
        const id = matches?.values().next().value as string | undefined
        const sessionId = id || `unknown-session:${digest}`
        if (!id) this.warn(`未能将消息表 ${table.name} 对应到已知联系人；以未识别会话保留。`)
        this.session(sessionId, id ? this.people.get(id)?.name : `未识别会话 ${digest.slice(0, 8)}`)
        tables.push({ source, table, sessionId }); recognized++
      }
      if (!recognized) this.warn(`未识别到受支持的消息表：${source.file.relativePath}。`)
    }
    return tables
  }

  catalog(): { people: Person[]; sessions: WeFlowSession[]; warnings: string[]; memberships: Membership[] } {
    this.ensureOpen()
    if (!this.contactTables) this.warn('未识别到联系人表，姓名、备注和别名可能不完整。')
    if (!this.sessionTables) this.warn('未识别到会话表；仅能使用已识别的消息表会话。')
    this.messageTables()
    return { people: [...this.people.values()].map(person => ({ ...person })), sessions: [...this.sessions.values()].map(session => ({ ...session })), warnings: [...this.warningSet], memberships: [...this.memberPairs.values()].map(member => ({ ...member })) }
  }

  private decode(value: unknown, label: string): string | undefined {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') {
      if (value.length <= MAX_CONTENT) return value
      this.warn(`${label}正文过大，未解码该字段。`); return undefined
    }
    if (!(value instanceof Uint8Array)) { this.warn(`${label}正文格式无法识别。`); return undefined }
    if (value.byteLength > MAX_CONTENT) { this.warn(`${label}正文过大，未解码该字段。`); return undefined }
    let bytes = Buffer.from(value)
    try {
      if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
        if (bytes.length < 9) throw new Error('Truncated Zstandard frame')
        bytes = zstdDecompressSync(bytes, { maxOutputLength: MAX_CONTENT })
      }
      else if (bytes.length >= 2 && bytes[0] === 0x78 && ((bytes[0] << 8) + bytes[1]) % 31 === 0) bytes = inflateSync(bytes, { maxOutputLength: MAX_CONTENT })
      const encoding = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8'
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch { this.warn(`${label}正文解压或文字解码失败；没有将二进制误当作聊天内容。`); return undefined }
  }
  private message(row: Row, descriptor: MessageTable, sessionId: string): Evidence | undefined {
    const { source, table } = descriptor
    const label = `${source.file.relativePath} / ${table.name}`
    const compressed = first(row, ['compress_content', 'CompressContent'])
    let rawContent = compressed === undefined ? '' : this.decode(compressed, label)
    if (!rawContent) rawContent = this.decode(first(row, CONTENT_COLUMNS), label)
    if (rawContent === undefined) return undefined
    const rawTime = integer(first(row, TIME_COLUMNS))
    const timestamp = rawTime === undefined ? 0 : rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 4_102_444_800_000) { this.warn(`${label}存在无效消息时间，已跳过。`); return undefined }
    const localId = string(first(row, LOCAL_COLUMNS) ?? row.__reader_rowid)
    const serverId = serverIdString(first(row, ['server_id', 'serverId', 'MesSvrID', 'msgSvrID', 'svr_id']))
    if (!localId && (!serverId || serverId === '0')) { this.warn(`${label}消息缺少可追溯 ID，已跳过。`); return undefined }
    const localType = integer(first(row, TYPE_COLUMNS)) ?? 0
    const baseType = localType >= 0 ? localType % 4_294_967_296 : localType
    let direction = integer(first(row, ['computed_is_send', 'is_send', 'isSend', 'IsSender', 'is_sender']))
    // Darwin v3 mesDes: 0 sent / 1 received; only apply to legacy Chat_* tables.
    // Schema reference: github.com/afumu/wetrace/internal/model.MessageDarwinV3.
    if (direction === undefined && /^chat_/i.test(table.name)) {
      const des = integer(first(row, ['mesDes', 'Des']))
      if (des === 0 || des === 1) direction = des === 0 ? 1 : 0
    }
    let senderId = string(first(row, ['sender_username', 'senderUserName', 'fromusername', 'from_user', 'm_nsFromUsr', 'sender']))
    if (!senderId) senderId = source.senderNames.get(string(first(row, ['real_sender_id', 'realSenderId', 'sender_id']))) || ''
    const prefix = /^\s*([A-Za-z\d_.@-]{4,}):\s*\r?\n/.exec(rawContent)
    const prefixIsIdentity = !!prefix && (this.people.has(prefix[1]) || /^wxid_|^accountId_|@/i.test(prefix[1]))
    if (!senderId && prefixIsIdentity) senderId = prefix![1]
    if (!senderId && direction === 1) senderId = this.options.ownerId
    if (!senderId && direction === 0 && !groupId(sessionId) && !sessionId.startsWith('unknown-session:')) senderId = sessionId
    if (!senderId) {
      senderId = `unknown-sender:${sessionId}`
      this.person(senderId, '未识别发送者')
      this.warn(`会话「${this.people.get(sessionId)?.name || sessionId}」含无法确认发送者的消息；未将其推定为本机用户。`)
    }
    const sender = this.person(senderId)
    if (direction === 1 && senderId !== this.options.ownerId) this.warn(`会话「${sessionId}」的发送标记与明确发送者不一致，保留发送者原始标识。`)
    if (groupId(sessionId) || this.people.get(sessionId)?.kind === 'group') {
      this.membership(senderId, sessionId)
      if (!this.rosterGroups.has(sessionId)) this.warn(`群「${this.people.get(sessionId)?.name || sessionId}」成员仅依据已读消息的发送者，不是完整名册。`)
    }
    const contentWithoutPrefix = prefixIsIdentity ? rawContent.slice(prefix![0].length) : rawContent
    const appXml = contentWithoutPrefix.includes('<') || contentWithoutPrefix.includes('&lt;') ? entities(contentWithoutPrefix) : ''
    const appType = xmlTag(appXml.replace(/<refermsg[\s\S]*?<\/refermsg>/gi, ''), 'type')
    let kind: MessageKind = ({ 1: 'text', 3: 'image', 34: 'voice', 43: 'video', 47: 'emoji', 62: 'video' } as Record<number, MessageKind>)[baseType] || 'other'
    let content = contentWithoutPrefix
    if (baseType === 49 || appXml.includes('<appmsg')) {
      kind = appType === '57' ? 'text' : appType === '6' ? 'file' : 'other'
      content = xmlTag(appXml, 'title') || (kind === 'file' ? '[文件]' : '[链接或引用消息]')
    } else if (kind === 'image') content = '[图片]'
    else if (kind === 'emoji') content = '[表情]'
    else if (kind === 'video') content = '[视频]'
    else if (kind === 'voice') content = '[语音]'
    else if (baseType === 48) content = `[位置] ${xmlAttribute(appXml, 'label') || xmlAttribute(appXml, 'poiname')}`.trim()
    const id = serverId && serverId !== '0' ? `${sessionId}:server:${serverId}` : `${sessionId}:local:${hash(source.file.relativePath + '\0' + table.name).slice(0, 12)}:${localId}`
    const referenceXml = /<refermsg(?:\s[^>]*)?>([\s\S]*?)<\/refermsg>/i.exec(appXml)?.[1] || ''
    const replyServer = serverIdString(xmlTag(referenceXml, 'svrid') || first(row, ['replyToMessageId', 'reply_to_server_id']) || '')
    const mediaMd5 = kind === 'image' || kind === 'emoji' ? (string(first(row, ['imageMd5', 'emojiMd5', 'md5'])) || xmlAttribute(appXml, 'md5') || xmlTag(appXml, 'md5')).toLowerCase() : ''
    const mediaKey = /^[a-f\d]{16,32}$/i.test(mediaMd5) ? `${kind}:${mediaMd5}` : undefined
    const fileName = string(first(row, ['imageDatName', 'fileName', 'mediaFileName'])) || (kind === 'file' ? xmlTag(appXml, 'title') : '')
    const messageSource = this.decode(first(row, ['source', 'msgSource']), label) || ''
    const atList = messageSource || appXml ? xmlTag(messageSource + appXml, 'atuserlist') : ''
    const mentionedIds = [...new Set(atList.split(/[,;\s]+/).filter(value => value && !['notify@all', 'all', '@all'].includes(value)))]
    for (const mentioned of mentionedIds) this.person(mentioned)
    const evidence: Evidence = { id, originalId: serverId && serverId !== '0' ? serverId : localId, sessionId, sessionName: this.sessions.get(sessionId)?.name || this.people.get(sessionId)?.name || sessionId, senderId, senderName: sender.name, timestamp, content, kind, ...(replyServer && replyServer !== '0' ? { replyTo: `${sessionId}:server:${replyServer}` } : {}), ...(mentionedIds.length ? { mentionedIds } : {}), ...(mediaKey ? { mediaKey } : {}), ...(fileName ? { mediaFileName: fileName } : {}) }
    if (!this.records.has(id)) this.records.set(id, { sourcePath: source.file.sourcePath, snapshotPath: source.file.snapshotPath, relativePath: source.file.relativePath, tableName: table.name, localId, serverId, sessionId, rawContent, ...(mediaMd5 ? { mediaMd5 } : {}), ...(fileName ? { mediaFileName: fileName } : {}) })
    return evidence
  }

  async load(sessionIds: string[], maxMessages: number, signal: AbortSignal, onProgress: (progress: Progress) => void): Promise<CaseDataset> {
    this.ensureOpen()
    if (this.loading) throw new Error('已有一项本地读取正在进行，请等待或先停止。')
    this.loading = true
    this.loadWarnings = new Set(this.warningSet)
    this.loadIncomplete = this.incomplete
    try { return await this.loadInternal(sessionIds, maxMessages, signal, onProgress) }
    finally { this.loading = false; this.loadWarnings = undefined; this.loadIncomplete = false }
  }

  private async loadInternal(sessionIds: string[], maxMessages: number, signal: AbortSignal, onProgress: (progress: Progress) => void): Promise<CaseDataset> {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new Error('消息条数上限必须是非负整数，0 表示全部。')
    const selected = [...new Set(sessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
    if (!selected.length) throw new Error('请先选择要读取的会话。')
    const tables = this.messageTables()
    const tableOrder = new Map(tables.map((descriptor, index) => [descriptor, index]))
    const sharedTables = tables.filter(item => item.sessionColumn)
    const sessionTables = new Map<string, MessageTable[]>()
    for (const descriptor of tables) if (descriptor.sessionId) {
      let list = sessionTables.get(descriptor.sessionId)
      if (!list) { list = []; sessionTables.set(descriptor.sessionId, list) }
      list.push(descriptor)
    }
    const messages: Evidence[] = []
    const seen = new Map<string, Evidence>()
    this.records.clear()
    let sessionsDone = 0, stopped = false, limited = false
    const notify = (sessionId: string) => onProgress({ sessionsDone, sessionsTotal: selected.length, messages: messages.length, sessionName: this.sessions.get(sessionId)?.name || sessionId })
    outer: for (const sessionId of selected) {
      if (signal.aborted) { stopped = true; break }
      notify(sessionId)
      const sources = [...(sessionTables.get(sessionId) || []), ...sharedTables].sort((a, b) => tableOrder.get(a)! - tableOrder.get(b)!)
      if (!sources.length) this.warn(`会话「${this.sessions.get(sessionId)?.name || sessionId}」没有可读取的消息表，不能认定其没有聊天记录。`)
      for (const descriptor of sources) {
        const { source, table, sessionColumn } = descriptor
        const timeColumn = column(table, TIME_COLUMNS)!
        const localColumn = column(table, LOCAL_COLUMNS)
        const order = [quote(timeColumn), ...(localColumn ? [quote(localColumn)] : [])].join(', ')
        const where = sessionColumn ? ` WHERE ${quote(sessionColumn)} = ?` : ''
        // CAST preserves compressed bytes even when WCDB declared a column TEXT;
        // asking node:sqlite for an invalid UTF-8 TEXT value would lose bytes.
        const payloadColumns = new Set([...CONTENT_COLUMNS, 'compress_content', 'CompressContent'].map(key))
        const projection = [...table.columns.values()].map(name => payloadColumns.has(key(name)) ? `CAST(${quote(name)} AS BLOB) AS ${quote(name)}` : quote(name)).join(', ')
        // A single cursor makes SQLite scan/sort this conversation once.
        // Reissuing ORDER BY with increasing OFFSET repeated that work for
        // every 500-message page and became quadratic on long conversations.
        const sql = `SELECT ${table.withoutRowid ? '' : 'rowid AS __reader_rowid, '}${projection} FROM ${quote(table.name)}${where} ORDER BY ${order}`
        try {
          const statement = source.db.prepare(sql)
          statement.setReadBigInts(true)
          let count = 0
          for (const row of statement.iterate(...(sessionColumn ? [sessionId] : [])) as Iterable<Row>) {
            if (signal.aborted) { stopped = true; break outer }
            const message = this.message(row, descriptor, sessionId)
            if (message) {
              const existing = seen.get(message.id)
              if (existing) {
                if (existing.content !== message.content || existing.timestamp !== message.timestamp || existing.senderId !== message.senderId) this.warn(`会话「${sessionId}」存在相同消息 ID 的冲突副本，仅计入一条，需核对来源。`)
              } else {
                seen.set(message.id, message); messages.push(message)
                if (maxMessages > 0 && messages.length >= maxMessages) { limited = true; break outer }
              }
            }
            count += 1
            if (count % PAGE_SIZE === 0) {
              notify(sessionId)
              await new Promise<void>(resolve => setImmediate(resolve))
            }
          }
          notify(sessionId)
        } catch { this.warn(`消息表读取失败：${source.file.relativePath} / ${table.name}，已保留其他可读消息。`) }
      }
      sessionsDone++; notify(sessionId)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (stopped) this.warn('用户停止了读取；当前档案仅包含停止前已读到的消息。')
    if (limited) this.warn(`已达到 ${maxMessages} 条消息上限；后续消息或会话尚未读取。`)
    messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    const warnings = [...(this.loadWarnings || this.warningSet), '来源是本机数据库的只读快照；结果仅代表所选账号、会话和快照时刻，不代表微信全部历史。', '图片、表情和语音仅保留标识与原有文字说明，未执行 OCR 或语音识别；没有请求任何网络媒体地址。']
    const dataset: CaseDataset = { schemaVersion: 1, id: this.datasetId, title: `${this.options.ownerName} · 本地微信档案`, source: 'local', importedAt: Date.now(), ownerId: this.options.ownerId, people: [...this.people.values()].map(person => ({ ...person })), messages, memberships: [...this.memberPairs.values()].map(member => ({ ...member })), coverage: { description: `本地数据库快照：所选 ${selected.length} 个会话，完成 ${sessionsDone} 个会话，读取 ${messages.length} 条消息。`, partial: this.loadIncomplete || stopped || limited, sessionCount: selected.length, messageCount: messages.length, warnings } }
    notify(selected[Math.min(sessionsDone, selected.length - 1)])
    return dataset
  }

  getSourceRecord(evidenceId: string): NativeSourceRecord | undefined {
    const record = this.records.get(evidenceId)
    return record ? { ...record } : undefined
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const source of this.opened.values()) { try { source.db.close() } catch { /* Close remaining handles even if one failed. */ } }
    this.opened.clear(); this.records.clear()
  }
}
