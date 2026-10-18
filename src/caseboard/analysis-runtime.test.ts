import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyProfile, profileMarkdown } from './dossier-profile'
import { AnalysisRuntime, type AnalysisScope, type AnalysisView, type ExportContext } from './analysis-runtime'
import { AnalysisClient, type AnalysisTransport } from './analysis-client'
import type { AliasMap, CaseDataset, DossierSummary, Evidence } from './types'

const time = new Date('2025-09-01T12:00:00').getTime()
function fixture(): CaseDataset {
  const message = (id: string, content: string, timestamp = time, senderId = 'me', sessionId = 'chen'): Evidence => ({ id, originalId: id, content, timestamp, senderId, senderName: senderId, sessionId, sessionName: sessionId, kind: 'text' })
  return {
    schemaVersion: 1, id: 'runtime-test', title: '背景分析測試', source: 'import', importedAt: time, ownerId: 'me',
    people: [{ id: 'me', name: '我', kind: 'self' }, { id: 'wang', name: '王小明', kind: 'person' }, { id: 'chen', name: '陈屿', kind: 'person' }, { id: 'other', name: '汪晓敏', kind: 'person' }, { id: 'group', name: '摄影群', kind: 'group' }],
    messages: [message('mention', 'wxm 想喝乌龙茶'), message('tie', '王小明在读摄影画册'), message('private', '下次去旧书店', time + 1000, 'wang', 'wang'), message('group', '王小明喝咖啡吗', time + 2000, 'chen', 'group'), message('tomorrow', '王小明明天到', time + 24 * 3600000)],
    memberships: [{ personId: 'wang', groupId: 'group' }, { personId: 'chen', groupId: 'group' }],
    coverage: { partial: true, description: '合成資料', sessionCount: 3, messageCount: 5, warnings: [] },
  }
}
const scope = (patch: Partial<AnalysisScope> = {}): AnalysisScope => ({ centerId: 'wang', customAliases: {}, startDate: '', endDate: '', excludedIds: [], query: '', kinds: ['direct', 'shared-group', 'mention', 'reply'], onlyPinned: false, pins: [], ...patch })
const context = (patch: Partial<ExportContext> = {}): ExportContext => ({ format: 'md', note: '人工備註', warnings: ['測試範圍警示'], board: { layout: {}, items: [] }, summary: null, fingerprint: 'scope-test', ...patch })
async function view(runtime: AnalysisRuntime, patch: Partial<AnalysisScope> = {}) { return await runtime.handle({ type: 'analyze', scope: scope(patch) }) as AnalysisView }

test('背景分析傳回完整原文 ID，主執行緒可精確映射並保留相同時間順序', async () => {
  const data = fixture(), runtime = new AnalysisRuntime()
  const defaults = await runtime.handle({ type: 'dataset', dataset: data }) as AliasMap
  assert.ok(defaults.wang.includes('wxm'))
  const result = await view(runtime)
  assert.equal('relatedMessages' in result.insights, false)
  assert.deepEqual(result.insights.hits.map(hit => [hit.evidenceId, hit.ambiguous]), [['mention', true], ['tie', false], ['group', false], ['tomorrow', false]])
  assert.deepEqual(result.insights.relatedMessageIds, ['mention', 'tie', 'private', 'group', 'tomorrow'])
  assert.deepEqual(result.visibleMessageIds, ['tomorrow', 'group', 'private', 'mention', 'tie'])
  const originals = new Map(data.messages.map(message => [message.id, message]))
  assert.deepEqual(result.insights.relatedMessageIds.map(id => originals.get(id)?.content), data.messages.map(message => message.content))
  assert.ok(result.graph.edges.every(edge => edge.evidenceIds.every(id => originals.has(id))))
  const searched = await view(runtime, { query: '乌龙茶' })
  assert.deepEqual(searched.visibleMessageIds, ['mention'])
  assert.deepEqual(searched.insights, result.insights, 'search does not narrow the underlying evidence dossier')
})

test('三種統計互斥相加，搜尋和釘選不改變統計，日期排除會重算', async () => {
  const runtime = new AnalysisRuntime()
  await runtime.handle({ type: 'dataset', dataset: fixture() })
  const initial = await view(runtime)
  const stats = initial.statistics!
  assert.equal(stats.all.messages, 5)
  assert.equal(stats.private.messages, 4)
  assert.equal(stats.group.messages, 1)
  assert.equal(stats.all.messages, stats.private.messages + stats.group.messages)
  for (const item of Object.values(stats)) {
    assert.equal(item.centerSent + item.ownerSent + item.otherSent, item.messages)
    assert.equal(item.hours.reduce((a, b) => a + b, 0), item.messages)
    assert.equal(item.kinds.reduce((a, b) => a + b.count, 0), item.messages)
    assert.equal(item.conversations.reduce((a, b) => a + b.count, 0), item.messages)
  }
  const searched = await view(runtime, { query: '不存在的關鍵詞', onlyPinned: true, kinds: [] })
  assert.deepEqual(searched.statistics, stats)
  assert.deepEqual(searched.completeGraph, initial.completeGraph)
  assert.equal(searched.graph.edges.length, 0)
  const filtered = await view(runtime, { startDate: '2025-09-01', endDate: '2025-09-01', excludedIds: ['group'] })
  assert.equal(filtered.statistics!.all.messages, 3)
  assert.equal(filtered.statistics!.group.messages, 0)
  const self = await view(runtime, { centerId: 'me' })
  assert.equal(self.statistics!.all.ownerSent, 0, 'self-centered records must not be counted twice')
})

test('單獨私聊與群聊報告只帶對應原文，完整報告包含三種統計', async () => {
  const runtime = new AnalysisRuntime()
  await runtime.handle({ type: 'dataset', dataset: fixture() })
  const privateMd = await runtime.handle({ type: 'export', scope: scope(), context: context({ conversationScope: 'private' }) }) as string
  const groupHtml = await runtime.handle({ type: 'export', scope: scope(), context: context({ format: 'html', conversationScope: 'group' }) }) as string
  const allMd = await runtime.handle({ type: 'export', scope: scope(), context: context() }) as string
  assert.ok(privateMd.includes('下次去旧书店'))
  assert.equal(privateMd.includes('王小明喝咖啡吗'), false)
  assert.ok(groupHtml.includes('王小明喝咖啡吗'))
  assert.equal(groupHtml.includes('下次去旧书店'), false)
  for (const label of ['全部相關記錄', '私聊相關記錄', '群聊相關記錄']) assert.ok(allMd.includes(label))
})

test('超過 25 個關係節點仍全部保留，群聊強度只計中心人物發言', async () => {
  const data = fixture(), runtime = new AnalysisRuntime()
  for (let index = 0; index < 60; index++) {
    const id = `peer-${index}`
    data.people.push({ id, name: `人物${index}`, kind: 'person' })
    data.messages.push({ ...data.messages[0], id: `e-${index}`, sessionId: id, sessionName: id, content: '王小明與舊書店' })
  }
  await runtime.handle({ type: 'dataset', dataset: data })
  const result = await view(runtime)
  assert.ok(result.completeGraph.nodes.length > 60)
  for (let index = 0; index < 60; index++) assert.ok(result.completeGraph.nodes.some(node => node.id === `peer-${index}`))
  const membership = result.completeGraph.edges.find(edge => edge.source === 'wang' && edge.target === 'group' && edge.kind === 'shared-group')!
  assert.equal(membership.strength, 0, 'other group members speaking must not inflate the center member strength')
})

test('連續變更日期、排除、關係、釘選與人物，不會復用上一份證據範圍', async () => {
  const runtime = new AnalysisRuntime()
  await runtime.handle({ type: 'dataset', dataset: fixture() })
  const [filtered, pinned, other] = await Promise.all([
    view(runtime, { startDate: '2025-09-01', endDate: '2025-09-01', excludedIds: ['tie'], kinds: ['mention'] }),
    view(runtime, { onlyPinned: true, pins: ['private'] }),
    view(runtime, { centerId: 'chen', customAliases: { chen: ['咖啡'] } }),
  ])
  assert.deepEqual(filtered.insights.hits.map(hit => hit.evidenceId), ['mention', 'group'])
  assert.equal(filtered.insights.relatedMessageIds.includes('tomorrow'), false)
  assert.equal(filtered.insights.relatedMessageIds.includes('tie'), false)
  assert.ok(filtered.graph.edges.every(edge => edge.kind === 'mention'))
  assert.deepEqual(pinned.visibleMessageIds, ['private'])
  assert.deepEqual(other.insights.hits.map(hit => hit.evidenceId), ['group'])
  const restored = await view(runtime)
  assert.equal(restored.insights.hits.length, 4)
  assert.ok(restored.insights.relatedMessageIds.includes('tie'))
  const nextDay = await view(runtime, { startDate: '2025-09-02', endDate: '2025-09-02' })
  assert.deepEqual(nextDay.insights.relatedMessageIds, ['tomorrow'])
  assert.equal(nextDay.graph.nodes.some(person => person.id === 'group'), false, 'a date range must not leave an invisible membership-only branch')
  const next = fixture()
  next.people.find(person => person.id === 'wang')!.name = '李新雨'
  next.messages = [{ ...next.messages[0], id: 'replacement', content: '李新雨打算去咖啡馆' }]
  await runtime.handle({ type: 'dataset', dataset: next })
  assert.deepEqual((await view(runtime)).insights.relatedMessageIds, ['replacement'])
})

test('卷宗只截短顯示預覽，Markdown 和 HTML 保留末尾原文與 AI 綜述', async () => {
  const data = fixture(), runtime = new AnalysisRuntime()
  data.messages = Array.from({ length: 160 }, (_, i) => ({ ...data.messages[0], id: `long-${i}`, originalId: `original-${i}`, timestamp: time + i * 1000, content: `王小明想喝乌龙茶。${'这是一段需要完整保存的原文证据。'.repeat(12)} ${i === 159 ? 'LAST_EVIDENCE_SENTINEL' : ''}` }))
  await runtime.handle({ type: 'dataset', dataset: data })
  const active = scope()
  const report = await runtime.handle({ type: 'report', scope: active, note: '人工備註', warnings: ['測試範圍警示'] }) as { preview: string; characters: number }
  const summary: DossierSummary = { generatedAt: time, model: 'test-model', endpoint: 'local', overview: 'AI_OVERVIEW_SENTINEL <script>example</script>', findings: [], preferences: [], topics: [], expressions: [], uncertainties: [], limitations: [], processedMessages: 160, totalMessages: 160 }
  const markdown = await runtime.handle({ type: 'export', scope: active, context: context() }) as string
  const withSummary = await runtime.handle({ type: 'export', scope: active, context: context({ summary }) }) as string
  const html = await runtime.handle({ type: 'export', scope: active, context: context({ format: 'html', summary }) }) as string
  assert.equal(report.preview.length, 30000)
  assert.ok(report.characters > 30000)
  const profileLength = profileMarkdown(emptyProfile(), data.people.find(person => person.id === active.centerId)!).length
  assert.equal(report.characters, markdown.length - profileLength, '預覽正文與檔案卡分開呈現')
  assert.equal(report.preview, markdown.slice(profileLength, profileLength + 30000))
  assert.ok(markdown.includes('LAST\\_EVIDENCE\\_SENTINEL'))
  assert.ok(html.includes('LAST_EVIDENCE_SENTINEL'))
  assert.ok(withSummary.includes('AI_OVERVIEW_SENTINEL'))
  assert.ok(html.includes('AI_OVERVIEW_SENTINEL &lt;script&gt;'))
  assert.equal(html.includes('<script>example</script>'), false)
  assert.ok(markdown.includes('人工備註'))
  assert.ok(html.includes('測試範圍警示'))
})

test('JSON 保存全部資料、人物檔案與篩查設定，BOM 導入只解析一次並恢復元資料', async () => {
  const data = fixture(), runtime = new AnalysisRuntime()
  await runtime.handle({ type: 'dataset', dataset: data })
  const active = scope({ excludedIds: ['mention'], pins: ['private'], startDate: '2025-09-01', endDate: '2025-09-01', kinds: ['mention'], customAliases: { wang: ['小明', 'wxm'] } })
  const board = { layout: { wang: { x: 20, y: 40 } }, items: [] }
  const profiles = { wang: { ...emptyProfile(), displayName: '檔案顯示名', avatarVariant: 199, commonPhrases: '改天聊', fields: [{ label: '待核線索', value: '合成資料' }] } }
  const json = await runtime.handle({ type: 'export', scope: active, context: context({ format: 'json', board, profiles }) }) as string
  const saved = JSON.parse(json)
  assert.equal(saved.messages.length, data.messages.length, 'excluded/date filters are reversible metadata')
  assert.deepEqual(saved.caseboard.excluded, ['mention'])
  assert.deepEqual(saved.caseboard.filters, { startDate: '2025-09-01', endDate: '2025-09-01', kinds: ['mention'] })
  const imported = await runtime.handle({ type: 'import', file: new File(['\uFEFF', json], '資料.json') }) as { dataset: CaseDataset; meta: any }
  assert.deepEqual(imported.dataset.messages, data.messages)
  assert.deepEqual(imported.meta.board, board)
  assert.deepEqual(imported.meta.profiles, profiles)
  assert.equal(imported.dataset.people.find(person => person.id === 'wang')!.name, '王小明')
  const html = await runtime.handle({ type: 'export', scope: active, context: context({ format: 'html', profiles, portrait: 'data:image/svg+xml;base64,PHN2Zy8+' }) }) as string
  assert.ok(html.includes('人物檔案 · 檔案顯示名'))
  assert.ok(html.includes('data:image/svg+xml;base64,PHN2Zy8+'))
  assert.ok(html.includes('改天聊'))
  assert.deepEqual(imported.meta.aliases.wang, ['小明', 'wxm'])
  assert.equal(imported.meta.notes.wang, '人工備註')
  await assert.rejects(runtime.handle({ type: 'import', file: new File(['{bad-json'], 'invalid.json') }), /JSON/)
})

test('搜索、釘選、備註預覽和導出共用人物分析，不重複執行中文分詞', async () => {
  const runtime = new AnalysisRuntime()
  await runtime.handle({ type: 'dataset', dataset: fixture() })
  await view(runtime)
  const prototype = (Intl as any).Segmenter.prototype
  const original = prototype.segment
  let segmentCalls = 0
  prototype.segment = function(text: string) { segmentCalls++; return original.call(this, text) }
  try {
    await view(runtime, { query: '乌龙茶', kinds: ['mention'] })
    await view(runtime, { onlyPinned: true, pins: ['private'] })
    await runtime.handle({ type: 'report', scope: scope(), note: '修改後的人工備註', warnings: [] })
    await runtime.handle({ type: 'export', scope: scope(), context: context({ format: 'html' }) })
    assert.equal(segmentCalls, 0, 'view-only settings and export formatting must reuse the existing topic analysis')
  } finally { prototype.segment = original }
})

test('Worker 合併同一事件迴圈的快速篩查，明確取消舊請求並只計算最後條件', async () => {
  const messages: any[] = []
  const worker = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage(value: unknown) { messages.push(value) } }
  const previous = (globalThis as any).self
  ;(globalThis as any).self = worker
  try { require('./analysis.worker') } finally {
    if (previous === undefined) delete (globalThis as any).self
    else (globalThis as any).self = previous
  }
  worker.onmessage!({ data: { id: 1, action: { type: 'dataset', dataset: fixture() } } })
  worker.onmessage!({ data: { id: 2, action: { type: 'analyze', scope: scope({ query: '乌' }) } } })
  worker.onmessage!({ data: { id: 3, action: { type: 'analyze', scope: scope({ query: '乌龙' }) } } })
  worker.onmessage!({ data: { id: 4, action: { type: 'analyze', scope: scope({ query: '乌龙茶' }) } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(messages.filter(message => message.superseded).map(message => message.id), [2, 3])
  assert.deepEqual(messages.find(message => message.id === 4)?.result.visibleMessageIds, ['mention'])
  assert.equal(messages.filter(message => message.id === 4).length, 1)
  assert.equal(messages.some(message => [2, 3].includes(message.id) && message.result), false)
})

class TestTransport implements AnalysisTransport {
  messages: any[] = []
  listeners = new Map<string, Set<(event: any) => void>>()
  terminated = false
  postMessage(message: unknown) { this.messages.push(message) }
  addEventListener(type: 'message' | 'error', listener: (event: any) => void) { const values = this.listeners.get(type) || new Set(); values.add(listener); this.listeners.set(type, values) }
  removeEventListener(type: 'message' | 'error', listener: (event: any) => void) { this.listeners.get(type)?.delete(listener) }
  terminate() { this.terminated = true }
  emit(type: 'message' | 'error', data: unknown) { for (const listener of this.listeners.get(type) || []) listener({ data }) }
}

test('客戶端按請求 ID 回傳結果，過期篩查可取消且不覆蓋下一個請求', async () => {
  const transport = new TestTransport(), client = new AnalysisClient(transport)
  const older = client.request({ type: 'analyze', scope: scope() })
  const newer = client.request({ type: 'analyze', scope: scope({ centerId: 'chen' }) })
  const oldRejected = assert.rejects(older, { name: 'AbortError' })
  transport.emit('message', { id: transport.messages[0].id, superseded: true })
  transport.emit('message', { id: transport.messages[0].id, result: 'stale result' })
  transport.emit('message', { id: transport.messages[1].id, result: 'new result' })
  await oldRejected
  assert.equal(await newer, 'new result')
  const broken = client.request({ type: 'report' })
  const brokenRejected = assert.rejects(broken, /specific failure/)
  transport.emit('message', { id: transport.messages[2].id, error: 'specific failure' })
  await brokenRejected
  client.dispose()
})

test('關閉客戶端拒絕未完成與後續請求，Worker 崩潰後也不會留下永久等待', async () => {
  const transport = new TestTransport(), client = new AnalysisClient(transport)
  const pending = client.request({ type: 'analyze' })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  client.dispose(); client.dispose()
  await rejected
  await assert.rejects(client.request({ type: 'report' }), { name: 'AbortError' })
  assert.equal(transport.terminated, true)
  assert.equal(transport.listeners.get('message')?.size, 0)
  const fatalTransport = new TestTransport(), fatalClient = new AnalysisClient(fatalTransport)
  const current = fatalClient.request({ type: 'dataset' })
  const currentRejected = assert.rejects(current, /背景分析/)
  fatalTransport.emit('error', null)
  await currentRejected
  const settled = await Promise.race([
    fatalClient.request({ type: 'report' }).then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 30)),
  ])
  fatalClient.dispose()
  assert.equal(settled, 'rejected', 'fatal worker errors must make later requests fail immediately')
})
