import { analyzePerson, defaultAliases } from './analysis'
import type { AliasMap, CaseDataset, CaseNotes, Evidence, MessageKind, Person, PersonInsights } from './types'

type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = (value: unknown, label: string): ObjectValue => { if (!isObject(value)) throw new Error(`${label}必须是对象。`); return value }
const array = (value: unknown, label: string): unknown[] => { if (!Array.isArray(value)) throw new Error(`${label}必须是数组。`); return value }
function str(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}必须是非空字符串（最多 ${max} 字符）。`)
  return value
}
const optionalString = (value: unknown, label: string, max = 1000) => value === undefined || value === null ? undefined : str(value, label, max)
function idString(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return str(value, label)
}
function timestamp(value: unknown, label: string): number {
  let numeric: number
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) numeric = Number(value)
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T| )\d{2}:\d{2}/.test(value)) {
    const [datePart, timePart] = value.split(/[T ]/)
    const [year, month, day] = datePart.split('-').map(Number)
    const dayCheck = new Date(Date.UTC(year, month - 1, day))
    const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(timePart)
    if (dayCheck.getUTCFullYear() !== year || dayCheck.getUTCMonth() !== month - 1 || dayCheck.getUTCDate() !== day || !timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59 || Number(timeMatch[3] ?? '0') > 59) throw new Error(`${label}日期无效。`)
    numeric = Date.parse(value)
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) throw new Error(`${label}日期字符串必须带时区（如 2025-09-01T10:00:00+08:00）。`)
  } else throw new Error(`${label}必须是秒、毫秒时间戳或带时区的 ISO 日期。`)
  const result = numeric < 100_000_000_000 ? numeric * 1000 : numeric
  if (!Number.isFinite(result) || result < 0 || result > 4_102_444_800_000) throw new Error(`${label}日期超出支持范围（1970–2100）。`)
  return Math.round(result)
}

const kinds = new Set<MessageKind>(['text', 'image', 'emoji', 'video', 'voice', 'file', 'other'])
function mediaFields(message: ObjectValue): Pick<Evidence, 'mediaKey' | 'mediaUrl' | 'mediaFileName'> {
  const firstPresent = (...values: unknown[]) => values.find(value => value !== undefined && value !== null && value !== '')
  const exportedPath = typeof message.content === 'string' && /^[^<>\r\n]{1,2000}\.(png|jpe?g|webp|gif)$/i.test(message.content.trim()) ? message.content.trim() : undefined
  const mediaKey = optionalString(firstPresent(message.mediaKey, message.emojiMd5, message.imageMd5, message.md5, exportedPath ? `file:${exportedPath}` : undefined), '媒体标识', 2100)
  const mediaFileName = optionalString(firstPresent(message.mediaFileName, message.fileName, message.filename, exportedPath?.split(/[\\/]/).pop()), '媒体文件名', 2000)
  const rawUrl = optionalString(firstPresent(message.mediaUrl, message.imageUrl, message.emojiCdnUrl), '媒体 URL', 10_000_000)
  let mediaUrl: string | undefined
  if (rawUrl && /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(rawUrl)) mediaUrl = rawUrl
  else if (rawUrl) {
    try {
      const url = new URL(rawUrl)
      if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password) mediaUrl = rawUrl
    } catch { /* Relative paths, external hosts and active formats remain unrendered. */ }
  }
  return { ...(mediaKey ? { mediaKey } : {}), ...(mediaUrl ? { mediaUrl } : {}), ...(mediaFileName ? { mediaFileName } : {}) }
}
function normalizeKind(value: unknown, chatlab = false): MessageKind {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    const types: Record<number, MessageKind> = chatlab
      ? { 0: 'text', 1: 'image', 2: 'voice', 3: 'video', 4: 'file', 5: 'emoji', 25: 'text' }
      : { 1: 'text', 3: 'image', 34: 'voice', 43: 'video', 47: 'emoji', 49: 'file' }
    return types[value] ?? 'other'
  }
  if (typeof value === 'string') {
    if (kinds.has(value as MessageKind)) return value as MessageKind
    const names: Record<string, MessageKind> = { '文本': 'text', '文字': 'text', '图片': 'image', '视频': 'video', '语音': 'voice', '文件': 'file', '其他': 'other', '系统消息': 'other', '表情': 'emoji', '链接': 'other', '引用': 'text' }
    if (names[value]) return names[value]
  }
  throw new Error('消息类型无效。请使用本应用 JSON、WeFlow JSON 或 ChatLab JSON。')
}

function validateDataset(value: ObjectValue): CaseDataset {
  if (value.schemaVersion !== 1) throw new Error('不支持的档案版本，当前支持 schemaVersion: 1。')
  const people: Person[] = array(value.people, 'people').map((item, index) => {
    const person = record(item, `people[${index}]`)
    if (person.kind !== 'self' && person.kind !== 'person' && person.kind !== 'group') throw new Error(`people[${index}].kind 无效。`)
    return { id: str(person.id, '联系人 ID'), name: str(person.name, '联系人姓名', 500), kind: person.kind, ...(person.alias !== undefined ? { alias: str(person.alias, '联系人别名', 500) } : {}) }
  })
  const ids = new Set(people.map(person => person.id))
  if (ids.size !== people.length) throw new Error('联系人 ID 重复，请先合并或修正。')
  const ownerId = str(value.ownerId, 'ownerId')
  if (!ids.has(ownerId) || people.find(person => person.id === ownerId)?.kind !== 'self') throw new Error('ownerId 必须指向 kind 为 self 的本机用户。')
  const messages: Evidence[] = array(value.messages, 'messages').map((item, index) => {
    const message = record(item, `messages[${index}]`)
    if (!kinds.has(message.kind as MessageKind)) throw new Error(`messages[${index}].kind 无效。`)
    if (typeof message.content !== 'string' || message.content.length > 1_000_000) throw new Error(`messages[${index}].content 必须为文本（最多 100 万字符）。`)
    const sessionId = str(message.sessionId, '会话 ID')
    const senderId = str(message.senderId, '发送者 ID')
    if (!ids.has(sessionId) || !ids.has(senderId)) throw new Error(`messages[${index}] 引用了不存在的会话或联系人。`)
    const mentionedIds = message.mentionedIds === undefined ? undefined : array(message.mentionedIds, 'mentionedIds').map(id => str(id, '提及联系人 ID'))
    if (mentionedIds?.some(id => !ids.has(id))) throw new Error(`messages[${index}] 的 mentionedIds 包含未知联系人。`)
    return { id: str(message.id, '消息 ID'), sessionId, sessionName: str(message.sessionName, '会话名称', 500), senderId, senderName: str(message.senderName, '发送者名称', 500), timestamp: timestamp(message.timestamp, `messages[${index}].timestamp`), content: message.content, kind: message.kind as MessageKind, ...mediaFields(message), ...(message.originalId !== undefined ? { originalId: idString(message.originalId, '原始消息 ID') } : {}), ...(message.replyTo !== undefined ? { replyTo: str(message.replyTo, '引用消息 ID') } : {}), ...(mentionedIds ? { mentionedIds } : {}) }
  })
  if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('消息 ID 重复，已停止导入，避免重复计数。')
  const memberships = array(value.memberships ?? [], 'memberships').map(item => {
    const membership = record(item, '群成员关系')
    const personId = str(membership.personId, '成员 ID'), groupId = str(membership.groupId, '群 ID')
    if (!ids.has(personId) || people.find(person => person.id === groupId)?.kind !== 'group' || people.find(person => person.id === personId)?.kind === 'group') throw new Error('群成员关系引用了不存在的成员或群聊。')
    return { personId, groupId }
  })
  if (new Set(memberships.map(item => JSON.stringify([item.personId, item.groupId]))).size !== memberships.length) throw new Error('群成员关系重复。')
  const coverage = record(value.coverage, 'coverage')
  if (typeof coverage.partial !== 'boolean') throw new Error('coverage.partial 必须为布尔值。')
  if (![coverage.messageCount, coverage.sessionCount].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) throw new Error('coverage 的消息数与会话数必须为非负整数。')
  const warnings = array(coverage.warnings, 'coverage.warnings').map(item => str(item, '覆盖范围提示', 5000))
  if (!['demo', 'weflow', 'import', 'local'].includes(value.source as string)) throw new Error('数据来源无效。')
  return { schemaVersion: 1, id: str(value.id, '档案 ID'), title: str(value.title, '档案名称', 500), source: value.source as CaseDataset['source'], importedAt: timestamp(value.importedAt, 'importedAt'), ownerId, people, messages: messages.sort((a, b) => a.timestamp - b.timestamp), memberships, coverage: { description: str(coverage.description, '覆盖范围说明', 10_000), partial: coverage.partial, sessionCount: new Set(messages.map(message => message.sessionId)).size, messageCount: messages.length, warnings } }
}

export function importDataset(text: string, filename = '导入档案.json'): CaseDataset {
  if (text.length > 60_000_000) throw new Error('文件超过 60 MB，请按会话或日期拆分后导入。')
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('文件不是有效 JSON。请从 WeFlow 导出 JSON / ChatLab JSON，或选择本应用档案 JSON。') }
  return importDatasetValue(parsed, filename)
}

/** Parse once in the background worker, retaining board metadata separately. */
export function importDatasetValue(parsed: unknown, filename = '导入档案.json'): CaseDataset {
  if (isObject(parsed) && 'schemaVersion' in parsed) return validateDataset(parsed)
  const root: ObjectValue = Array.isArray(parsed) ? { messages: parsed } : record(parsed, '导入数据')
  const rawMessages = array(root.messages, 'messages')
  const chatlab = isObject(root.chatlab)
  const meta = isObject(root.meta) ? root.meta : {}
  const session = isObject(root.session) ? root.session : {}
  const people = new Map<string, Person>()
  const rawMembers = root.members === undefined ? [] : array(root.members, 'members')
  for (const entry of rawMembers) {
    const member = record(entry, '成员')
    const id = idString(member.platformId ?? member.accountId ?? member.id, '成员 ID')
    if (people.has(id)) throw new Error('导出文件中的成员 ID 重复。')
    people.set(id, { id, name: str(member.accountName ?? member.displayName ?? member.name ?? id, '成员名称', 500), kind: 'person' })
  }
  const outgoingIds = rawMessages.flatMap(item => {
    const message = record(item, '消息')
    if (message.isSend !== undefined && ![0, 1, false, true].includes(message.isSend as number)) throw new Error('isSend 必须为 0、1 或布尔值。')
    return message.isSend === 1 || message.isSend === true ? [message.senderUsername ?? message.senderId ?? message.sender].filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  })
  const distinctOwnerIds = [...new Set(outgoingIds)]
  if (distinctOwnerIds.length > 1) throw new Error('文件中 isSend 指向多个本机账号，请分账号导入。')
  const explicitOwner = root.ownerId ?? (isObject(root.owner) ? root.owner.id : undefined)
  const ownerId = explicitOwner !== undefined ? idString(explicitOwner, '本机账号 ID') : distinctOwnerIds[0] ?? '__self__'
  if (distinctOwnerIds.length && distinctOwnerIds[0] !== ownerId) throw new Error('ownerId 与 isSend 标识的本机账号冲突。')
  const ownerKnown = explicitOwner !== undefined || distinctOwnerIds.length > 0
  people.set(ownerId, { id: ownerId, name: people.get(ownerId)?.name ?? (ownerKnown ? '我' : '我（导入文件未标识）'), kind: 'self' })
  const sessionName = str(session.displayName ?? session.nickname ?? session.name ?? meta.name ?? root.sessionName ?? filename.replace(/\.[^.]+$/, ''), '会话名称', 500)
  const group = meta.type === 'group' || session.type === 'group' || session.type === '群聊' || String(session.accountId ?? root.talker ?? '').includes('@chatroom')
  const peerCandidates = !group && ownerKnown ? [...people.keys()].filter(id => id !== ownerId) : []
  const peer = peerCandidates.length === 1 ? peerCandidates[0] : undefined
  const sessionId = idString(session.accountId ?? session.id ?? meta.groupId ?? root.sessionId ?? root.talker ?? peer ?? (group ? 'import-group' : 'import-session'), '会话 ID')
  if (sessionId === ownerId) throw new Error('会话 ID 与本机账号相同，无法确定会话对象。')
  people.set(sessionId, { id: sessionId, name: sessionName, kind: group ? 'group' : 'person' })
  const messages: Evidence[] = []
  const ids = new Set<string>()
  for (const [index, item] of rawMessages.entries()) {
    const message = record(item, `messages[${index}]`)
    const sid = idString(message.sessionId ?? sessionId, '消息会话 ID')
    if (!people.has(sid)) people.set(sid, { id: sid, name: optionalString(message.sessionName, '会话名称', 500) ?? sid, kind: sid.includes('@chatroom') ? 'group' : 'person' })
    const sentByOwner = message.isSend === 1 || message.isSend === true
    const rawSender = sentByOwner ? ownerId : message.senderUsername ?? message.senderId ?? message.sender ?? (people.get(sid)?.kind !== 'group' ? sid : undefined)
    const senderId = idString(rawSender, `messages[${index}] 发送者 ID`)
    const senderName = optionalString(message.senderDisplayName ?? message.senderName ?? message.accountName, '发送者名称', 500) ?? people.get(senderId)?.name ?? senderId
    if (!people.has(senderId)) people.set(senderId, { id: senderId, name: senderName, kind: senderId === ownerId ? 'self' : 'person' })
    else if (senderId === ownerId && senderName !== ownerId && senderName !== '我') people.set(ownerId, { id: ownerId, name: senderName, kind: 'self' })
    const platformId = [message.platformMessageId, message.serverId].find(value => value !== undefined && value !== null && value !== '' && String(value) !== '0')
    const originalId = idString(platformId ?? message.localId ?? message.id ?? `row-${index + 1}`, '原始消息 ID')
    const id = `${sid}:${originalId}`
    if (ids.has(id)) throw new Error(`消息 ID 重复：${originalId}。已停止导入，避免重复计数。`)
    ids.add(id)
    const contentValue = message.content ?? message.parsedContent ?? message.rawContent ?? ''
    if (typeof contentValue !== 'string' || contentValue.length > 1_000_000) throw new Error(`messages[${index}].content 必须为文本（最多 100 万字符）。`)
    const reply = message.replyToMessageId ?? message.replyTo ?? (isObject(message.quote) ? message.quote.platformMessageId : undefined)
    messages.push({ id, originalId, sessionId: sid, sessionName: optionalString(message.sessionName, '会话名称', 500) ?? people.get(sid)!.name, senderId, senderName, timestamp: timestamp(message.timestamp ?? message.createTime ?? message.time, `messages[${index}] 时间`), content: contentValue, kind: normalizeKind(message.localType ?? message.kind ?? message.type, chatlab), ...mediaFields(message), ...(reply !== undefined && reply !== null ? { replyTo: `${sid}:${idString(reply, '引用消息 ID')}` } : {}) })
  }
  const memberships = [...people.values()].filter(person => person.kind === 'group').flatMap(room => {
    const observed = new Set(messages.filter(message => message.sessionId === room.id).map(message => message.senderId))
    if (room.id === sessionId) for (const item of rawMembers) observed.add(idString(record(item, '成员').platformId ?? record(item, '成员').accountId ?? record(item, '成员').id, '成员 ID'))
    return [...observed].filter(id => people.get(id)?.kind !== 'group').map(personId => ({ personId, groupId: room.id }))
  })
  const warnings = ['导入文件只代表其中包含的会话与时间范围，不能据此认定微信全部历史已覆盖。', '媒体只预览受限的内嵌光栅图片或本机地址；外部图片链接不会载入。未执行 OCR、语音识别或重新解密。']
  if (!ownerKnown) warnings.push('导出文件未明确标识本机账号；“我提及的次数”暂为 0，请使用带 ownerId 的本应用格式，或通过本机微信资料读取补全。')
  if (group) warnings.push('群成员仅来自导出名册或已出现的发送者，不代表完整成员名单。')
  return { schemaVersion: 1, id: `import-${Date.now()}`, title: sessionName, source: chatlab || isObject(root.weflow) || root.talker !== undefined ? 'weflow' : 'import', importedAt: Date.now(), ownerId, people: [...people.values()], messages: messages.sort((a, b) => a.timestamp - b.timestamp), memberships, coverage: { description: `从 ${filename} 导入 ${new Set(messages.map(message => message.sessionId)).size} 个会话、${messages.length} 条消息；范围以文件内容为准。`, partial: true, sessionCount: new Set(messages.map(message => message.sessionId)).size, messageCount: messages.length, warnings } }
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const escapeMarkdown = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|\-])/g, '\\$1')
const iso = (value: number) => new Date(value).toISOString()
const personAliases = (person: Person, aliases: AliasMap) => Object.prototype.hasOwnProperty.call(aliases, person.id) ? aliases[person.id] : defaultAliases(person)
const personNote = (personId: string, notes: CaseNotes) => Object.prototype.hasOwnProperty.call(notes, personId) && typeof notes[personId] === 'string' ? notes[personId] : ''

export function generateDossierMarkdown(dataset: CaseDataset, centerId: string, aliases: AliasMap = {}, notes: CaseNotes = {}, preparedInsights?: PersonInsights): string {
  const person = dataset.people.find(item => item.id === centerId)
  if (!person) throw new Error('未找到中心人物。')
  const insights = preparedInsights ?? analyzePerson(dataset, centerId, aliases)
  const e = escapeMarkdown
  const first = dataset.messages.reduce((min, message) => Math.min(min, message.timestamp), Infinity)
  const last = dataset.messages.reduce((max, message) => Math.max(max, message.timestamp), -Infinity)
  const lines = [`# ${e(person.name)} · 线索档案`, '', `档案：${e(dataset.title)}`, '', `来源：${dataset.source === 'demo' ? '虚构演示' : dataset.source === 'local' ? '本机微信资料' : dataset.source === 'weflow' ? 'WeFlow JSON 导入' : '文件导入'}；载入时间：${iso(dataset.importedAt)}`, '', '## 数据范围', '', e(dataset.coverage.description), '', `已载入 ${dataset.messages.length} 条消息、${new Set(dataset.messages.map(message => message.sessionId)).size} 个会话；${dataset.coverage.partial ? '范围不完整' : '文件声明范围完整，但不代表微信全部历史'}。`, '', `消息时间：${dataset.messages.length ? `${iso(first)} 至 ${iso(last)}` : '无消息'}。全部时间为 UTC。`, '', ...dataset.coverage.warnings.map(warning => `- ${e(warning)}`), '', '## 检索依据', '', `中心人物 ID：${e(person.id)}`, '', `检索词：${personAliases(person, aliases).map(e).join('、') || '无文字别名'}`, '', e(insights.summary), '', '说明：中文姓名按原文匹配，拉丁缩写忽略大小写并匹配完整词；同一消息只计一次。候选提及不等于身份确认，话题来自直接会话、提及原文及同会话 15 分钟内相邻一条上下文。未推断人物性格、隐藏关系或其他人的私聊。', '', '## 哪些会话经常提起', '', '| 会话 | 候选消息数 | 本机用户发送数 | 证据 ID |', '| --- | ---: | ---: | --- |', ...insights.conversationMentions.map(item => `| ${e(item.name)} | ${item.count} | ${item.selfCount} | ${item.evidenceIds.map(e).join('、')} |`), '', '## 相关话题', '', '本地分词与停用词过滤；次数为包含该词/短语的相关消息数，并非语义断言。', '', ...insights.topics.map(topic => `- **${e(topic.label)}**：${topic.count} 条；证据：${topic.evidenceIds.map(e).join('、')}`), '', '## 人工备注', '', '以下由用户手动记录，与自动检索结果独立；未经证据验证。', '', ...(personNote(centerId, notes) ? personNote(centerId, notes).split(/\r?\n/).map(line => `> ${e(line)}`) : ['暂无人工备注。']), '', '## 原文证据与上下文', '']
  const hitById = new Map(insights.hits.map(hit => [hit.evidenceId, hit]))
  for (const message of insights.relatedMessages) {
    const hit = hitById.get(message.id)
    lines.push(`### ${e(message.id)}`, '', `原始 ID：${e(message.originalId ?? message.id)}  ·  时间：${iso(message.timestamp)}  ·  会话：${e(message.sessionName)}（${e(message.sessionId)}）  ·  发送者：${e(message.senderName)}（${e(message.senderId)}）  ·  类型：${message.kind}`, '', hit ? `检索词：${e(hit.matchedAlias)}；${hit.ambiguous ? '存在同名/缩写歧义，待核对' : '文本匹配候选 / 明确 @ 标识'}。` : '来源：直接会话、本人发言或相邻上下文，不计为文字提及。', '', ...message.content.split(/\r?\n/).map(line => `> ${e(line)}`), '', ...(message.replyTo ? [`引用消息 ID：${e(message.replyTo)}`, ''] : []))
  }
  if (!insights.relatedMessages.length) lines.push('当前载入范围内没有相关消息。')
  return lines.join('\n')
}

export function generateDossierHtml(dataset: CaseDataset, centerId: string, aliases: AliasMap = {}, notes: CaseNotes = {}, preparedInsights?: PersonInsights): string {
  const person = dataset.people.find(item => item.id === centerId)
  if (!person) throw new Error('未找到中心人物。')
  const insights = preparedInsights ?? analyzePerson(dataset, centerId, aliases)
  const e = escapeHtml
  const hitById = new Map(insights.hits.map(hit => [hit.evidenceId, hit]))
  const evidenceIndexes = new Map(insights.relatedMessages.map((message, index) => [message.id, index]))
  const refs = (ids: string[]) => ids.map(id => evidenceIndexes.has(id) ? `<a href="#evidence-${evidenceIndexes.get(id)}">${e(id)}</a>` : e(id)).join(' · ')
  const first = dataset.messages.reduce((min, message) => Math.min(min, message.timestamp), Infinity)
  const last = dataset.messages.reduce((max, message) => Math.max(max, message.timestamp), -Infinity)
  const conversations = insights.conversationMentions.map(item => `<tr><td>${e(item.name)}<small>${e(item.sessionId)}</small></td><td>${item.count}</td><td>${item.selfCount}</td><td class="refs">${refs(item.evidenceIds)}</td></tr>`).join('')
  const topics = insights.topics.map(topic => `<article class="topic"><b>${e(topic.label)}</b><span>${topic.count} 条消息</span><p class="refs">${refs(topic.evidenceIds)}</p></article>`).join('')
  const evidence = insights.relatedMessages.map((message, index) => {
    const hit = hitById.get(message.id)
    return `<article class="evidence" id="evidence-${index}"><header><b>${e(message.sessionName)}</b><time>${iso(message.timestamp)}</time></header><small>发送者：${e(message.senderName)}（${e(message.senderId)}） · 会话 ID：${e(message.sessionId)} · 类型：${message.kind}</small><p class="status">${hit ? `检索词：${e(hit.matchedAlias)} · ${hit.ambiguous ? '同名/缩写歧义，待人工核对' : '文本匹配候选 / 明确 @ 标识'}` : '直接会话、本人发言或相邻上下文；不计为文字提及'}</p><blockquote>${e(message.content)}</blockquote><small>证据 ID：${e(message.id)} · 原始消息 ID：${e(message.originalId ?? message.id)}${message.replyTo ? ` · 引用：${e(message.replyTo)}` : ''}</small></article>`
  }).join('')
  // Only escaped text is interpolated; no imported markup, remote media or scripts.
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(person.name)} · 线索档案</title><style>
*{box-sizing:border-box}body{margin:0;background:#eee9d8;color:#383e34;font-family:"Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.85}main{max-width:1000px;margin:40px auto;padding:42px;background:#fffdf5;border:2px solid #68745c;box-shadow:8px 8px 0 #cad1bc}h1{font-size:30px;margin:8px 0;color:#354d40}h2{font-size:19px;margin:34px 0 14px;border-bottom:2px solid #c9d2bd;padding-bottom:8px}p{margin:10px 0}.eyebrow{font:12px monospace;letter-spacing:3px;color:#6b7864}.sub,small{color:#6b7366;font-size:12px}small{display:block;overflow-wrap:anywhere}.notice,.notes{padding:18px;background:#edf0df;border-left:4px solid #8b9c78}.notes{white-space:pre-wrap;background:#fff0d9;border-color:#c2a278}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}.stat{padding:12px 22px;border:1px solid #c7d0b8;min-width:140px}.stat strong{display:block;font-size:24px}.stat span{font-size:12px;color:#6b7366}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;padding:10px;border-bottom:1px solid #dedfcd;vertical-align:top;overflow-wrap:anywhere}th{background:#e8ecda}th:nth-child(2),th:nth-child(3){width:95px}th:first-child{width:180px}a{color:#4d7058;text-decoration:underline;text-underline-offset:3px}.refs{font:11px/1.8 ui-monospace,monospace;overflow-wrap:anywhere}.topics{display:grid;grid-template-columns:1fr 1fr;gap:12px}.topic{padding:14px;border:1px solid #d1d7c4}.topic b{font-size:17px}.topic span{float:right;font-size:12px;color:#74816b}.evidence{padding:20px 0;border-bottom:1px solid #d5d9c8;scroll-margin:20px;break-inside:avoid}.evidence header{display:flex;justify-content:space-between;gap:16px}.evidence time{font:11px monospace;color:#78806e}.status{font-size:12px;color:#7b764e}blockquote{margin:12px 0;padding:14px 18px;white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f2e7;border-left:3px solid #a5b397}.empty{color:#777d71}.foot{margin-top:32px;font-size:12px;color:#6b7366}@media(max-width:700px){main{margin:12px;padding:22px}.topics{grid-template-columns:1fr}table{table-layout:auto}th,td{padding:6px}th:first-child{width:auto}}@media print{body{background:white}main{margin:0;box-shadow:none;border:0;padding:12px}a{color:inherit}.evidence{break-inside:avoid}.refs{font-size:9px}}
</style></head><body><main><div class="eyebrow">YAOZHUO / PERSON DOSSIER</div><h1>${e(person.name)} · 线索档案</h1><p class="sub">${e(dataset.title)} · ${dataset.source === 'demo' ? '完全虚构演示' : dataset.source === 'local' ? '本机微信资料' : dataset.source === 'weflow' ? 'WeFlow JSON 导入' : '本地文件导入'}<br>人物 ID：${e(person.id)} · 载入时间：${iso(dataset.importedAt)}（UTC）</p>
<div class="stats"><div class="stat"><strong>${insights.hits.length}</strong><span>提及候选消息</span></div><div class="stat"><strong>${insights.conversationMentions.length}</strong><span>出现提及的会话</span></div><div class="stat"><strong>${insights.hits.filter(hit => hit.ambiguous).length}</strong><span>存在歧义 · 待核对</span></div></div>
<h2>数据范围</h2><div class="notice"><p>${e(dataset.coverage.description)}</p><p>已载入 ${dataset.messages.length} 条消息、${new Set(dataset.messages.map(message => message.sessionId)).size} 个会话；${dataset.coverage.partial ? '范围不完整' : '文件声明范围完整，不代表微信全部历史'}。</p><small>消息时间：${dataset.messages.length ? `${iso(first)} 至 ${iso(last)}` : '无消息'}；全部时间为 UTC。</small><ul>${dataset.coverage.warnings.map(warning => `<li>${e(warning)}</li>`).join('')}</ul></div>
<h2>检索依据</h2><p>${e(insights.summary)}</p><p>检索词：${personAliases(person, aliases).map(e).join('、') || '无文字别名'}</p><p class="sub">中文按原文匹配；拉丁缩写忽略大小写并匹配完整词；同一消息只计一次。候选提及不等于身份确认。话题取自直接会话、提及原文及同会话 15 分钟内相邻一条上下文。不推断人物性格、隐藏关系或其他人的私聊。</p>
<h2>哪些会话经常提起</h2>${conversations ? `<table><thead><tr><th>会话</th><th>候选消息</th><th>本机用户发送</th><th>原文证据</th></tr></thead><tbody>${conversations}</tbody></table>` : '<p class="empty">当前范围没有提及候选。</p>'}
<h2>相关话题</h2><p class="sub">本地分词与停用词过滤；次数为出现该词/短语的相关消息数，不代表语义断言。点击证据 ID 可跳到原文。</p><div class="topics">${topics || '<p class="empty">暂无足够的重复词语。</p>'}</div>
<h2>人工备注</h2><p class="sub">以下由用户手动记录，与自动检索结果独立，未经证据验证。</p><div class="notes">${e(personNote(centerId, notes) || '暂无人工备注。')}</div>
<h2>原文证据与上下文</h2>${evidence || '<p class="empty">当前载入范围内没有相关消息。</p>'}<p class="foot">本档案由本地数据生成，所有结论应结合原文核对。导出文件包含原始聊天内容，请按你的用途妥善保管。</p></main></body></html>`
}
