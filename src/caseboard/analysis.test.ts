import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzePerson, buildGraph, createAnalysisEngine, defaultAliases } from './analysis'
import { demoDataset } from './demo'
import { characterNames, characterVariant, relationWidth } from './pixel-characters'
import { generateDossierHtml, generateDossierMarkdown, importDataset } from './import-export'
import type { CaseDataset, Evidence } from './types'

const baseTime = Date.UTC(2025, 8, 1)
test('像素角色穩定分配 200 款，線寬隨觀測頻次增加且有上限', () => {
  assert.equal(characterNames.length, 200)
  assert.equal(new Set(Array.from({ length: 200 }, (_, index) => characterVariant('same', index))).size, 200)
  assert.equal(characterVariant('wxid-example'), characterVariant('wxid-example'))
  const widths = [0, 1, 2, 10, 100, 1000].map(relationWidth)
  assert.ok(widths.every((width, index) => !index || width > widths[index - 1]))
  assert.equal(relationWidth(NaN), relationWidth(0))
  assert.ok(relationWidth(1e12) < 8)
})
function fixture(): CaseDataset {
  const lines = [
    ['a', 'chen', 'me', '王小明和 wxm 约在旧书店，一起看摄影画册。'],
    ['b', 'chen', 'chen', 'WXM 周末要去旧书店研究摄影。'],
    ['c', 'chen', 'me', 'wxm123 和 xxwxm 都是别的账号。'],
    ['d', 'chen', 'me', 'A+B 想去看摄影画册。'],
    ['e', 'chen', 'me', 'AAB 是另外一个缩写。'],
    ['f', 'wang', 'wang', '旧书店的摄影画册到货了。'],
    ['g', 'group', 'wang', '周末去旧书店看摄影。'],
  ]
  const messages: Evidence[] = lines.map(([id, sessionId, senderId, content], index) => ({ id, originalId: `original-${id}`, sessionId, sessionName: sessionId, senderId, senderName: senderId, timestamp: baseTime + index * 1000, content, kind: 'text', ...(id === 'b' ? { replyTo: 'a' } : {}) }))
  return { schemaVersion: 1, id: 'test', title: '测试', source: 'import', importedAt: baseTime, ownerId: 'me', people: [{ id: 'me', name: '我', kind: 'self' }, { id: 'wang', name: '王小明', alias: '小明', kind: 'person' }, { id: 'chen', name: '陈屿', kind: 'person' }, { id: 'other-wxm', name: '汪晓敏', kind: 'person' }, { id: 'group', name: '读书群', kind: 'group' }], messages, memberships: [{ personId: 'me', groupId: 'group' }, { personId: 'wang', groupId: 'group' }, { personId: 'chen', groupId: 'group' }], coverage: { description: '测试数据', partial: true, sessionCount: 3, messageCount: 7, warnings: [] } }
}

test('全局别名检索：首字母、完整词、正则字符、去重和歧义', () => {
  const data = fixture()
  assert.ok(defaultAliases(data.people[1]).includes('wxm'))
  const insights = analyzePerson(data, 'wang', { wang: ['王小明', 'wxm', 'A+B'] })
  assert.deepEqual(insights.hits.map(hit => hit.evidenceId), ['a', 'b', 'd'])
  assert.equal(insights.hits.find(hit => hit.evidenceId === 'a')!.ambiguous, false)
  assert.equal(insights.hits.find(hit => hit.evidenceId === 'b')!.ambiguous, true)
  assert.equal(insights.conversationMentions[0].count, 3)
  assert.equal(insights.conversationMentions[0].selfCount, 2)
  assert.ok(insights.relatedMessages.some(message => message.id === 'f'))
  assert.ok(insights.topics.some(topic => topic.label.includes('摄影') || topic.label.includes('书店')))
  for (const topic of insights.topics) assert.equal(topic.count, new Set(topic.evidenceIds).size)
})

test('图谱只用可见会话建边，日期和搜索过滤生效', () => {
  const data = fixture()
  const graph = buildGraph(data, 'wang')
  assert.ok(graph.edges.some(edge => edge.source === 'wang' && edge.target === 'chen' && edge.kind === 'mention'))
  assert.equal(graph.edges.some(edge => edge.kind === 'direct' && edge.source === 'wang' && edge.target === 'chen'), false)
  assert.ok(graph.edges.some(edge => edge.kind === 'direct' && edge.target === 'me'))
  assert.ok(graph.edges.some(edge => edge.kind === 'reply' && edge.evidenceIds.includes('b')))
  assert.ok(graph.nodes.length <= 25)
  const filtered = buildGraph(data, 'wang', { start: baseTime + 1000, end: baseTime + 1000, query: 'WXM' })
  assert.deepEqual(filtered.edges.flatMap(edge => edge.evidenceIds), ['b', 'b'])
})

test('引用的裸原始 ID 只在当前会话内解析，不跨会话串线', () => {
  const data = fixture()
  data.messages.find(message => message.id === 'f')!.originalId = 'same-server-id'
  data.messages.find(message => message.id === 'g')!.replyTo = 'a'
  data.messages.push({ ...data.messages[0], id: 'other-collision', sessionId: 'chen', senderId: 'chen', originalId: 'same-server-id' })
  data.messages.push({ ...data.messages[5], id: 'local-reply', senderId: 'me', originalId: 'new-server-id', replyTo: 'same-server-id' })
  const graph = buildGraph(data, 'wang')
  assert.ok(graph.edges.some(edge => edge.kind === 'reply' && edge.source === 'me' && edge.target === 'wang' && edge.evidenceIds.includes('f') && edge.evidenceIds.includes('local-reply')))
  assert.equal(graph.edges.some(edge => edge.kind === 'reply' && edge.evidenceIds.includes('other-collision')), false)
  assert.equal(graph.edges.some(edge => edge.kind === 'reply' && edge.evidenceIds.includes('g')), false)
})

test('演示统计来自 120 条可回溯的虚构消息', () => {
  assert.equal(demoDataset.messages.length, 120)
  assert.equal(demoDataset.coverage.messageCount, 120)
  assert.equal(demoDataset.coverage.sessionCount, 9)
  assert.equal(new Set(demoDataset.messages.map(message => message.id)).size, 120)
  assert.equal(demoDataset.messages.filter(message => message.mediaKey === 'demo:book').length, 4)
  assert.equal(demoDataset.messages.filter(message => message.kind === 'emoji' && message.mediaKey === 'demo:cat').length, 4)
  assert.ok(analyzePerson(demoDataset, 'lin').conversationMentions.some(item => item.sessionId === 'chen'))
  assert.ok(analyzePerson(demoDataset, 'lin').topics.some(topic => topic.label.includes('摄影')))
  assert.equal(analyzePerson(demoDataset, 'lin').topics.some(topic => topic.label.includes('林知')), false)
})

test('本应用档案往返与严格校验', () => {
  const result = importDataset(JSON.stringify(demoDataset))
  assert.equal(result.messages.length, 120)
  assert.equal(result.messages[0].timestamp, demoDataset.messages[0].timestamp)
  const duplicate = structuredClone(demoDataset)
  duplicate.messages.push(duplicate.messages[0])
  assert.throws(() => importDataset(JSON.stringify(duplicate)), /消息 ID 重复/)
  const invalid = structuredClone(demoDataset)
  ;(invalid.messages[0] as unknown as Record<string, unknown>).timestamp = '2025-02-30T10:00:00+08:00'
  assert.throws(() => importDataset(JSON.stringify(invalid)), /日期无效/)
  ;(invalid.messages[0] as unknown as Record<string, unknown>).timestamp = baseTime
  ;(invalid.messages[0] as unknown as Record<string, unknown>).kind = 'script'
  assert.throws(() => importDataset(JSON.stringify(invalid)), /kind 无效/)
})

test('WeFlow 实际 JSON 字段：秒时间戳、本机账号与引用', () => {
  const result = importDataset(JSON.stringify({ weflow: { version: '5.0' }, session: { accountId: 'friend', displayName: '王小明', type: '私聊' }, messages: [{ localId: 1, platformMessageId: '111', createTime: 1756684800, localType: 1, isSend: 1, senderUsername: 'my-account', senderDisplayName: '我', content: '王小明，去旧书店吗？' }, { localId: 2, platformMessageId: '112', replyToMessageId: '111', createTime: 1756684810, localType: 1, isSend: 0, senderUsername: 'friend', senderDisplayName: '王小明', content: '去。' }] }))
  assert.equal(result.ownerId, 'my-account')
  assert.equal(result.messages[0].timestamp, 1756684800000)
  assert.equal(result.messages[1].replyTo, 'friend:111')
  assert.equal(result.messages[0].originalId, '111')
})

test('ChatLab 不猜测本机身份，缺失账号以覆盖提示说明', () => {
  const result = importDataset(JSON.stringify({ chatlab: { version: '0.0.2' }, meta: { name: '摄影群', type: 'group', groupId: 'photo@chatroom' }, members: [{ platformId: 'a', accountName: '甲' }, { platformId: 'b', accountName: '乙' }], messages: [{ sender: 'a', accountName: '甲', timestamp: 1756684800, type: 0, content: '摄影画册', platformMessageId: '123' }] }))
  assert.equal(result.messages[0].kind, 'text')
  assert.equal(result.messages[0].senderId, 'a')
  assert.ok(result.coverage.warnings.some(warning => warning.includes('未明确标识本机账号')))
  assert.equal(result.memberships.length, 2)
})

test('媒体标识和频次可往返，SVG 与外部图片链接不进入预览', () => {
  const data = structuredClone(demoDataset)
  data.messages[0].mediaUrl = 'https://tracking.example/image.png'
  data.messages[1].mediaUrl = 'data:image/svg+xml;base64,PHN2Zz4='
  data.messages[2].mediaUrl = 'data:image/png;base64,iVBORw0KGgo='
  const imported = importDataset(JSON.stringify({ ...data, caseboard: { notes: {} } }))
  assert.equal(imported.messages.find(message => message.id === 'demo-001')!.mediaUrl, undefined)
  assert.equal(imported.messages.find(message => message.id === 'demo-002')!.mediaUrl, undefined)
  assert.equal(imported.messages.find(message => message.id === 'demo-003')!.mediaUrl, data.messages[2].mediaUrl)
  assert.equal(imported.messages.filter(message => message.mediaKey === 'demo:book').length, 4)
})

test('导出隔离人工备注，原始 ID 与危险 HTML 全部转义', () => {
  const data = fixture()
  data.messages[0].content += '<script>alert(1)</script>'
  const notes = { wang: '<img src=x onerror=alert(1)>未核实' }
  const markdown = generateDossierMarkdown(data, 'wang', {}, notes)
  assert.ok(markdown.includes('original\\-a'))
  assert.ok(markdown.includes('人工备注'))
  assert.ok(markdown.includes('待核对'))
  assert.equal(markdown.includes('<script>'), false)
  const html = generateDossierHtml(data, 'wang', {}, notes)
  assert.ok(html.includes('original-a'))
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.ok(html.includes('Content-Security-Policy'))
})

test('复用索引仍按会话时间找相邻证据，语境不会递归扩散或跨会话', () => {
  const data = fixture()
  const message = (id: string, time: number, content: string, sessionId = 'chen'): Evidence => ({ ...data.messages[0], id, originalId: id, timestamp: baseTime + time, sessionId, content })
  data.messages = [
    message('after-two', 2000, '不应扩散到第二条后文'),
    message('before', -1000, '直接相邻前文'),
    message('anchor', 0, '王小明说要喝乌龙茶'),
    message('after', 1000, '直接相邻后文'),
    message('far', 20 * 60 * 1000, '超过十五分钟'),
    message('other-chat', 0, '同时刻的另一会话', 'group'),
  ]
  const engine = createAnalysisEngine(data)
  assert.deepEqual(engine.analyze('wang').relatedMessages.map(message => message.id), ['before', 'anchor', 'after'])
  assert.deepEqual(engine.graph('wang').edges.find(edge => edge.kind === 'mention')?.evidenceIds, ['anchor'])
  // Search restricts both the returned edge evidence and the visible count.
  const searched = engine.graph('wang', { query: '乌龙茶' })
  assert.deepEqual(searched.edges.flatMap(edge => edge.evidenceIds), ['anchor', 'anchor'])
  assert.equal(searched.nodes.find(person => person.id === 'chen')?.messageCount, 1)
  assert.equal(searched.nodes.some(person => person.id === 'group'), false)
})

test('别名修改立即重新核对歧义，明确的 @ 标识始终优先于缩写', () => {
  const data = fixture()
  data.messages.push({ ...data.messages[0], id: 'explicit-mention', content: 'wxm 到了吗', mentionedIds: ['wang'] })
  const aliases = { wang: ['wxm'] }
  const engine = createAnalysisEngine(data)
  const first = engine.analyze('wang', aliases)
  assert.equal(first.hits.find(hit => hit.evidenceId === 'b')?.ambiguous, true)
  assert.equal(first.hits.find(hit => hit.evidenceId === 'explicit-mention')?.ambiguous, false)
  aliases.wang = ['A+B']
  const edited = engine.analyze('wang', aliases)
  assert.deepEqual(edited.hits.map(hit => hit.evidenceId), ['d', 'explicit-mention'])
  assert.equal(engine.graph('wang', {}, aliases).edges.some(edge => edge.kind === 'mention' && edge.evidenceIds.includes('b')), false)
  // Returned default suggestions are copies; editing one cannot corrupt later people.
  defaultAliases(data.people[1]).push('corrupt-suggestion')
  assert.equal(defaultAliases(data.people[1]).includes('corrupt-suggestion'), false)
})

test('关系筛选与缓存保留原有可见会话边界，载入新增消息会更新旧接口', () => {
  const data = fixture()
  const engine = createAnalysisEngine(data)
  const full = engine.graph('wang')
  assert.ok(full.edges.some(edge => edge.source === 'me' && edge.target === 'chen' && edge.kind === 'direct'))
  const directOnly = engine.graph('wang', { kinds: ['direct'] })
  assert.deepEqual(directOnly.edges.map(edge => [edge.source, edge.target]), [['wang', 'me']])
  const before = analyzePerson(data, 'wang')
  data.messages.push({ ...data.messages[0], id: 'new-message', content: '王小明刚刚到旧书店了。' })
  assert.equal(analyzePerson(data, 'wang').hits.length, before.hits.length + 1)
  assert.ok(buildGraph(data, 'wang').edges.some(edge => edge.evidenceIds.includes('new-message')))
})
