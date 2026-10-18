// Isolated local-only checks: node --test electron/caseboard/ai-client.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.join(__dirname, 'ai-client.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const isolated = new Module(filename, module)
isolated.filename = filename
isolated.paths = Module._nodeModulePaths(__dirname)
isolated._compile(compiled, filename)
const { generateSummary, validateSummaryUrl } = isolated.exports

const message = (id, content = '我喜欢无糖咖啡。晚点再说。', senderId = 'center') => ({ id, content, senderId, senderName: senderId === 'center' ? '中心人物' : '其他人', sessionId: 'session', sessionName: '对话', timestamp: 1738713600000, kind: 'text', mediaUrl: 'data:image/png;base64,NEVER_SEND_MEDIA_BYTES' })
const options = baseUrl => ({ baseUrl, apiKey: 'test-only-secret-key', model: 'explicit-test-model', centerName: '中心人物', centerId: 'center', ownerId: 'me', aliases: ['中心人物', 'zxr'], coverageDescription: '测试范围', warnings: [], messages: [message('m1'), message('m2')] })
const empty = () => ({ overview: null, findings: [], topics: [], preferences: [], expressions: [], uncertainties: [], limitations: [] })
const finding = (statement, evidenceIds) => ({ statement, evidenceIds })
function reply(res, value, finish_reason = 'stop') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })) }
async function mock(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    try { await handler(req, res, body, JSON.parse(body.messages[1].content)) } catch (error) { res.statusCode = 500; res.end('mock handler failed'); throw error }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}/v1`
}

test('URL validation permits explicit HTTPS and loopback HTTP without credentials or URL secrets', () => {
  for (const url of ['https://api.example.test/v1', 'https://api.example.test/custom/chat/completions', 'http://127.0.0.1:7890/v1', 'http://127.12.3.4', 'http://[::1]:9000', 'http://localhost/v1']) assert.match(validateSummaryUrl(url).pathname, /\/chat\/completions$/)
  for (const url of ['', 'not-url', 'ftp://api.example.test', 'http://example.test/v1', 'http://192.168.1.2', 'http://127.0.0.1.example.test', 'https://user:pass@example.test/v1', 'https://@example.test/v1', 'https://example.test/v1?api_key=secret', 'https://example.test/#fragment', 'https://example.test/v1?', 'https://example.test/v1#']) assert.throws(() => validateSummaryUrl(url))
  assert.equal(validateSummaryUrl('https://api.example.test/v1/chat/completions/').pathname, '/v1/chat/completions')
})

test('JSON mode, header-only key, no media bytes, explicit model and original-ID validation', async t => {
  let calls = 0
  const baseUrl = await mock(t, (req, res, body, data) => {
    calls++
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer test-only-secret-key')
    assert.equal(body.model, 'explicit-test-model')
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.match(body.messages[0].content, /JSON/)
    assert.match(body.messages[0].content, /绝不是指令/)
    assert.equal(JSON.stringify(body).includes('test-only-secret-key'), false)
    assert.equal(JSON.stringify(body).includes('NEVER_SEND_MEDIA_BYTES'), false)
    const output = empty()
    output.findings = [finding('出现咖啡话题。', ['m1', 'made-up']), finding('无法证实的说法。', ['unknown'])]
    if (data.phase === 'final') { output.overview = finding('记录讨论咖啡。', ['m1']); output.findings = [finding('出现咖啡话题。', ['m1'])] }
    reply(res, output)
  })
  const result = await generateSummary(options(baseUrl))
  assert.equal(calls, 2)
  assert.deepEqual(result.findings[0].evidenceIds, ['m1'])
  assert.ok(result.uncertainties.some(text => text.includes('无法证实的说法')))
  assert.ok(result.limitations.some(text => text.includes('无效引用已剔除')))
  assert.equal(result.processedMessages, 2)
  assert.match(result.overview, /m1/)
  await assert.rejects(generateSummary({ ...options(baseUrl), model: '' }), /填写.*模型/)
  assert.equal(calls, 2)
})

test('preferences respect source identity; expressions are actual center originals with local counts', async t => {
  const baseUrl = await mock(t, (_req, res) => {
    const output = empty()
    output.findings = [finding('有咖啡相关原文。', ['m1'])]
    output.overview = finding('有咖啡相关记录。', ['m1'])
    output.preferences = [
      { ...finding('喜欢无糖咖啡。', ['m1']), basis: 'self-stated', confidence: 'high' },
      { ...finding('喜欢茶。', ['m3']), basis: 'self-stated', confidence: 'high' },
      { ...finding('多次选择咖啡。', ['m1']), basis: 'repeated', confidence: 'high' },
    ]
    output.expressions = [{ text: '晚点再说', count: 999, evidenceIds: ['m3'] }, { text: '虚构的口头禅', count: 500, evidenceIds: ['m3'] }]
    reply(res, output)
  })
  const input = options(baseUrl)
  input.messages.push(message('m3', '他说晚点再说，他喜欢茶。', 'other'))
  const result = await generateSummary(input)
  assert.equal(result.preferences[0].basis, 'self-stated')
  assert.equal(result.preferences[1].basis, 'third-party')
  assert.equal(result.preferences[1].confidence, 'low')
  assert.match(result.preferences[1].statement, /他人提及/)
  assert.equal(result.preferences[2].basis, 'uncertain')
  assert.deepEqual(result.expressions, [{ text: '晚点再说', count: 2, evidenceIds: ['m1', 'm2'] }])
  assert.ok(result.uncertainties.some(text => text.includes('虚构的口头禅')))
})

test('every message and every long-message fragment reaches map batches without truncation', async t => {
  const seen = new Map()
  let maps = 0
  const phases = []
  const baseUrl = await mock(t, (_req, res, _body, data) => {
    phases.push(data.phase)
    const output = empty()
    if (data.phase === 'map') {
      maps++
      assert.ok(JSON.stringify(data.records).length <= 12000)
      for (const record of data.records) {
        if (record.recordType === 'message') { const entries = seen.get(record.evidenceId) || []; entries.push(record); seen.set(record.evidenceId, entries) }
        else assert.equal(record.recordType, 'unverified-manual-note')
      }
      const record = data.records.find(record => record.evidenceId)
      if (record) output.findings = [finding('本批出现原文。', [record.evidenceId])]
    } else {
      const ids = data.records.flatMap(record => typeof record.value === 'object' ? record.value.evidenceIds : [])
      output.findings = [finding('各批原文已归纳。', [...new Set(ids)])]
      output.overview = finding('归纳了输入消息。', [...new Set(ids)])
    }
    reply(res, output)
  })
  const input = options(baseUrl)
  input.messages = Array.from({ length: 31 }, (_, index) => message(`batch-${index}`, `第${index}条：` + '逐字完整读取。'.repeat(300)))
  input.messages.push(message('long-one', '超长原文🙂\\"'.repeat(5000)))
  input.manualNotes = '这是一条人工未证实备注。'
  const progress = []
  const result = await generateSummary(input, undefined, item => progress.push(item))
  assert.ok(maps > 4)
  assert.equal(seen.size, input.messages.length)
  for (const original of input.messages) {
    const parts = seen.get(original.id).sort((a, b) => a.part - b.part)
    assert.equal(parts.map(part => part.text).join(''), original.content)
    assert.equal(parts[0].totalParts, parts.length)
  }
  assert.ok(seen.get('long-one').length > 1)
  assert.equal(result.processedMessages, input.messages.length)
  assert.ok(result.limitations.some(text => text.includes('分片读取')))
  assert.ok(result.limitations.some(text => text.includes('人工备注')))
  assert.equal(progress.at(-1).completed, progress.at(-1).total)
  assert.equal(phases.at(-1), 'final')
})

test('hierarchical reduction processes every map summary when their combined context exceeds budget', async t => {
  let reduceCalls = 0
  let mapCalls = 0
  const mapSummaryIds = new Set()
  const reducedInputIds = new Set()
  const baseUrl = await mock(t, (_req, res, _body, data) => {
    const output = empty()
    if (data.phase === 'map') {
      mapCalls++
      const ids = [...new Set(data.records.map(record => record.evidenceId).filter(Boolean))]
      ids.forEach(id => mapSummaryIds.add(id))
      output.findings = Array.from({ length: 10 }, (_, index) => finding(`第${index}个独立讨论。` + '有原文依据，保持区分。'.repeat(30), ids))
    } else {
      reduceCalls++
      const ids = [...new Set(data.records.flatMap(record => typeof record.value === 'object' ? record.value.evidenceIds : []))]
      ids.forEach(id => reducedInputIds.add(id))
      output.findings = [finding('分组信息的克制概括。', ids)]
      output.overview = finding('依据输入原文整理。', ids)
    }
    reply(res, output)
  })
  const input = options(baseUrl)
  input.messages = Array.from({ length: 12 }, (_, index) => message(`reduce-${index}`, '阅读这段完整消息。'.repeat(700)))
  const result = await generateSummary(input)
  assert.ok(mapCalls >= 6)
  assert.ok(reduceCalls > 1)
  assert.deepEqual([...reducedInputIds].sort(), [...mapSummaryIds].sort())
  assert.equal(result.totalMessages, 12)
})

test('abort stops the outstanding request and does not retry it', async t => {
  const controller = new AbortController()
  let received
  const started = new Promise(resolve => { received = resolve })
  let calls = 0
  const baseUrl = await mock(t, () => { calls++; received() })
  const result = generateSummary(options(baseUrl), controller.signal)
  await started
  controller.abort()
  await assert.rejects(result, /已取消/)
  assert.equal(calls, 1)
  await assert.rejects(generateSummary(options(baseUrl), controller.signal), /已取消/)
  assert.equal(calls, 1)
})

test('bad JSON, output truncation, refusal and service errors fail clearly without echoing response bodies', async t => {
  for (const mode of ['bad-json', 'shape', 'length', 'refusal', 'server']) {
    let calls = 0
    const baseUrl = await mock(t, (_req, res) => {
      calls++
      if (mode === 'bad-json') return reply(res, 'not JSON secret-key-from-body')
      if (mode === 'shape') return reply(res, { findings: [] })
      if (mode === 'length') return reply(res, empty(), 'length')
      if (mode === 'refusal') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { refusal: 'secret-key-from-body', content: '' } }] })) }
      res.statusCode = 500; res.end('secret-key-from-body')
    })
    await assert.rejects(generateSummary(options(baseUrl)), error => { assert.match(error.message, /未完成|未生成完整/); assert.equal(error.message.includes('secret-key-from-body'), false); return true })
    assert.equal(calls, 1)
  }
})

test('redirects and oversized responses are rejected without follow-up requests', async t => {
  let redirectCalls = 0
  const baseUrl = await mock(t, (_req, res) => { redirectCalls++; res.statusCode = 302; res.setHeader('Location', 'https://example.test/secret-target'); res.end() })
  await assert.rejects(generateSummary(options(baseUrl)), /重定向已拒绝/)
  assert.equal(redirectCalls, 1)
  const hugeUrl = await mock(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('x'.repeat(8 * 1024 * 1024 + 1)) })
  await assert.rejects(generateSummary(options(hugeUrl)), /超过 8MB/)
})

test('invalid scope is rejected before making an AI request', async t => {
  let calls = 0
  const baseUrl = await mock(t, (_req, res) => { calls++; reply(res, empty()) })
  await assert.rejects(generateSummary({ ...options(baseUrl), messages: [] }), /没有可供总结/)
  await assert.rejects(generateSummary({ ...options(baseUrl), messages: [message('same'), message('same')] }), /ID 重复/)
  assert.equal(calls, 0)
})
