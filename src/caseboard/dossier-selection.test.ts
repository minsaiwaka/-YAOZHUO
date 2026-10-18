import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { buildSummaryRequest, selectSummaryMessages, summarySelection, validateStoredSummary } from './ai-selection'
import { emptyProfile, profileHtml, profileMarkdown, validateProfile } from './dossier-profile'
import { summaryHtml, summaryMarkdown } from './summary-format'
import { generateSummary } from '../../electron/caseboard/ai-client'
import type { DossierSummary, Evidence } from './types'

const messages: Evidence[] = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, sessionId: i < 2 ? 'center' : 'other', sessionName: i < 2 ? '中心私聊' : '另一會話', senderId: 'center', senderName: '中心', timestamp: 1738713600000 + i * 1000, kind: 'text', content: i < 2 ? '晚點再說，我喜歡無糖咖啡。' : 'SECRET_NOT_SELECTED 晚點再說。' }))
const context = { centerName: '中心', centerId: 'center', ownerId: 'me', aliases: ['中心'], coverageDescription: '合成測試資料', warnings: [], messages, manualNotes: 'MANUAL_NOTE_NOT_SELECTED' }
const service = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'synthetic-model', apiKey: 'local-test' }
const fixture = (): DossierSummary => ({ generatedAt: 1, model: 'synthetic', endpoint: 'http://localhost', overview: '概括', findings: [{ statement: '有記錄', evidenceIds: ['m0', 'm3'] }], topics: [], preferences: [], expressions: [{ text: '晚點再說', count: 99, evidenceIds: ['m0', 'm1', 'm2', 'm3'] }], uncertainties: [], limitations: [], processedMessages: 2, totalMessages: 2 })

test('全選、會話與逐條選擇只從目前可用的相關原文取值，空選擇不發送', () => {
  const sessions = selectSummaryMessages(messages, 'sessions', new Set(['center', 'not-loaded']), new Set())
  assert.deepEqual(sessions.map(m => m.id), ['m0', 'm1'])
  const individual = selectSummaryMessages(messages, 'messages', new Set(['other']), new Set(['m1', 'm3', 'not-loaded']))
  assert.deepEqual(individual.map(m => m.id), ['m1', 'm3'])
  assert.deepEqual(selectSummaryMessages(messages, 'all', new Set(), new Set()), messages)
  assert.throws(() => buildSummaryRequest(context, [], summarySelection(messages, [], 'messages', false), service), /至少/)
  const scope = summarySelection(messages, sessions, 'sessions', false)
  const request = buildSummaryRequest(context, sessions, scope, service)
  assert.equal(request.manualNotes, undefined)
  assert.equal(request.messages.length, 2)
  assert.match(request.coverageDescription, /1 \/ 2 個會話，2 \/ 4 條/)
  assert.equal(buildSummaryRequest(context, sessions, { ...scope, includeManualNotes: true }, service).manualNotes, context.manualNotes)
})

test('實際 AI 分批與合併請求均不含未勾選原文或未勾選人工備註', async t => {
  let calls = 0
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    assert.equal(raw.includes('SECRET_NOT_SELECTED'), false)
    assert.equal(raw.includes('MANUAL_NOTE_NOT_SELECTED'), false)
    calls++
    const data = JSON.parse(JSON.parse(raw).messages[1].content)
    if (data.phase === 'map') assert.deepEqual(data.records.filter((r: any) => r.evidenceId).map((r: any) => r.evidenceId), ['m0', 'm1'])
    const output = { overview: { statement: '選定原文提到咖啡', evidenceIds: ['m0'] }, findings: [{ statement: '選定原文提到咖啡', evidenceIds: ['m0'] }], topics: [], preferences: [], expressions: [{ text: '晚點再說', evidenceIds: ['m0', 'm1'] }], uncertainties: [], limitations: [] }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const selected = messages.slice(0, 2), scope = summarySelection(messages, selected, 'sessions', false)
  const request = buildSummaryRequest(context, selected, scope, { ...service, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })
  const result = await generateSummary(request)
  assert.equal(calls, 2)
  assert.equal(result.processedMessages, 2)
  assert.equal(result.totalMessages, 2)
  assert.equal(result.expressions[0].count, 2)
})

test('部分總結導入後只按原選取範圍重算常用語，剔除範圍外引用', () => {
  const value = { ...fixture(), selection: summarySelection(messages, messages.slice(0, 2), 'messages', false) }
  const restored = validateStoredSummary(JSON.parse(JSON.stringify(value)), messages, 'center')!
  assert.ok(restored)
  assert.deepEqual(restored.expressions[0].evidenceIds, ['m0', 'm1'])
  assert.equal(restored.expressions[0].count, 2)
  assert.deepEqual(restored.findings[0].evidenceIds, ['m0'])
  assert.equal(restored.selection!.sessions[0].count, 2)
  assert.match(summaryMarkdown(restored), /指定消息.*2 \/ 4 條/)
  assert.match(summaryHtml(restored), /指定消息.*2 \/ 4 條/)
  assert.equal(validateStoredSummary({ ...value, selection: { ...value.selection, messageIds: ['m0', 'unknown'] } }, messages, 'center'), null)
  assert.equal(validateStoredSummary({ ...value, selection: { ...value.selection, availableMessages: 1 } }, messages, 'center'), null)
  assert.equal(validateStoredSummary({ ...value, totalMessages: 4 }, messages, 'center'), null)
  const legacy = validateStoredSummary({ ...fixture(), expressions: [{ text: '晚點再說', count: 2, evidenceIds: ['m0', 'm1'] }] }, messages, 'center')!
  assert.equal(legacy.expressions[0].count, 2, '舊版只有引用時也不能擴大到其他聊天')
})

test('人工檔案校驗與導出保留照片編號、空白和自訂欄，轉義內容且不修改聯絡人', () => {
  const original = { id: 'person', name: '<原始名>', kind: 'person' as const }
  const profile = validateProfile({ ...emptyProfile(), displayName: '顯示名', avatarVariant: 199, commonPhrases: '好呀\n晚點再說', preferences: '烏龍茶', fields: [{ label: '<script>', value: '<img src=x onerror=alert(1)>' }], updatedAt: 10 })
  assert.equal(profile.avatarVariant, 199)
  assert.equal(profile.commonPhrases, '好呀\n晚點再說')
  assert.equal(validateProfile({ avatarVariant: 200 }).avatarVariant, undefined)
  assert.equal(validateProfile({ avatarVariant: -1 }).avatarVariant, undefined)
  const html = profileHtml(profile, original, 'data:image/svg+xml;base64,PHN2Zy8+')
  assert.ok(html.includes('data:image/svg+xml;base64,PHN2Zy8+'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<img src=x'))
  assert.match(profileMarkdown(profile, original), /200/)
  assert.match(profileMarkdown(profile, original), /人工整理/)
  assert.equal(original.name, '<原始名>')
  assert.ok(!profileHtml(profile, original, 'javascript:alert(1)').includes('javascript:'))
})
