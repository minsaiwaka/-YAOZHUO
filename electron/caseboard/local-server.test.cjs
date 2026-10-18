// Only synthetic archives are used; the adapter is embedded, with no external WeFlow server.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const ts = require('typescript')
const modules = new Map()
function loadSource(name) {
  const filename = path.join(__dirname, `${name}.ts`)
  if (modules.has(filename)) return modules.get(filename).exports
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const current = new Module(filename, module)
  modules.set(filename, current); current.filename = filename; current.paths = Module._nodeModulePaths(__dirname)
  current.require = request => request.startsWith('./') ? loadSource(request.slice(2)) : Module.prototype.require.call(current, request)
  current._compile(compiled, filename)
  return current.exports
}
const { createCaseboardApi } = loadSource('local-server')
async function fixture(t, overrides = {}) {
  const archive = { discover: async () => ({ accounts: [], searched: [], platform: 'test' }), autoSetup: async () => ({ status: 'needs-wechat', accounts: [], warnings: [], message: '请登录微信', verifiedDatabases: 0, totalDatabases: 0 }), open: async () => ({ people: [], sessions: [], connectionId: 'fixture' }), load: async () => ({}), media: async () => ({}), close: async () => {}, dispose: async () => {}, ...overrides }
  let api
  const server = http.createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end() } }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  api = createCaseboardApi(origin, archive)
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin, api }
}
function post(origin, action, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/caseboard-api/${action}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    request.on('error', reject); request.end(JSON.stringify(body))
  })
}
test('cross-origin and non-JSON requests cannot open local files', async t => {
  let opened = 0
  const { origin } = await fixture(t, { open: async () => { opened++; return {} } })
  const rejected = await post(origin, 'catalog', { accountPath: 'synthetic' }, { Origin: 'https://untrusted.example' })
  assert.equal(rejected.status, 403); assert.equal(rejected.headers['access-control-allow-origin'], undefined)
  assert.equal((await post(origin, 'catalog', {}, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal(opened, 0)
})
test('same-origin catalog uses the embedded adapter and redacts database keys', async t => {
  const secret = 'b'.repeat(64), fileKey = 'c'.repeat(64)
  const { origin } = await fixture(t, { open: async options => { assert.equal(options.key, secret); throw new Error(`failed ${secret} ${fileKey}`) } })
  assert.equal((await post(origin, 'discover', {})).status, 200)
  const rejected = await post(origin, 'catalog', { accountPath: 'fixture', key: secret, keys: { 'contact.db': fileKey } })
  assert.equal(rejected.status, 400); assert.equal(JSON.stringify(rejected.value).includes(secret), false); assert.equal(JSON.stringify(rejected.value).includes(fileKey), false)
})
test('SSE and cancel-load cover message reading without an external service', async t => {
  let started
  const began = new Promise(resolve => { started = resolve })
  const { origin } = await fixture(t, { load: async (_options, signal, progress) => {
    progress({ sessionsDone: 0, sessionsTotal: 1, messages: 4, sessionName: '虚构会话' }); started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { messages: [], coverage: { partial: true, warnings: ['已取消'] } }
  } })
  let observed
  const progressSeen = new Promise(resolve => { observed = resolve })
  await new Promise((resolve, reject) => {
    const subscription = http.get(`${origin}/caseboard-api/events`, { headers: { 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/caseboard.html` } }, response => {
      assert.equal(response.statusCode, 200)
      let buffer = '', connected = false
      response.on('data', chunk => {
        buffer += chunk.toString(); if (!connected) { connected = true; resolve() }
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) { const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); if (event.startsWith('data: ')) observed(JSON.parse(event.slice(6))) }
      })
    }); subscription.on('error', reject)
  })
  const loading = post(origin, 'load', { connectionId: 'fixture', sessionIds: ['alice'], maxMessages: 0 })
  await began
  assert.equal((await progressSeen).payload.messages, 4)
  assert.equal((await post(origin, 'catalog', {})).status, 409)
  assert.equal((await post(origin, 'cancel-load', {})).value.cancelled, true)
  const result = await loading
  assert.equal(result.status, 200); assert.equal(result.value.coverage.partial, true)
  assert.equal((await post(origin, 'close-connection', { connectionId: 'fixture' })).value.closed, true)
})
