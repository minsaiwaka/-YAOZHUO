// Exercise the original NDJSON protocol using synthetic in-memory child pipes.
// No external executable, WeChat process, or private key is opened by this suite.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const ts = require('typescript')
const sourcePath = path.join(__dirname, 'weflow-provider.ts')
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const KEY = 'A1'.repeat(32), SECRET = 'private-provider-text-should-never-be-exposed'
const providerPath = path.resolve(__filename)

function fixture(behavior, options = {}) {
  const state = { spawns: [], kills: [], payload: '', progress: [] }
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  child.stdin.on('data', chunk => { state.payload += chunk.toString() })
  child.kill = signal => { state.kills.push(signal); return true }
  const current = new Module(sourcePath, module)
  current.filename = sourcePath; current.paths = Module._nodeModulePaths(__dirname)
  current.require = name => name === 'node:child_process' ? {
    spawn: (...args) => {
      state.spawns.push(args)
      if (options.throwSpawn) throw new Error(SECRET)
      setImmediate(() => behavior?.(child, state))
      return child
    }
  } : Module.prototype.require.call(current, name)
  current._compile(compiled, sourcePath)
  return {
    state, child,
    invoke: (request = { action: 'get_db_key' }, control = new AbortController(), timeoutMs = 1000, filename = providerPath, onProgress = message => state.progress.push(message)) => current.exports.invokeWeFlowProvider(filename, request, control.signal, onProgress, { timeoutMs })
  }
}
const line = value => `${JSON.stringify(value)}\n`
function noLeak(result, state) {
  const text = JSON.stringify({ result, progress: state.progress })
  assert.equal(text.includes(SECRET), false)
  assert.equal(text.includes(KEY), false)
  assert.equal(text.includes(KEY.toLowerCase()), false)
}

test('only absolute existing component files and valid requests may spawn', async () => {
  const f = fixture()
  assert.equal((await f.invoke(undefined, undefined, 10, 'relative-component.exe')).success, false)
  assert.equal((await f.invoke(undefined, undefined, 10, path.join(__dirname, 'missing-provider.exe'))).success, false)
  for (const request of [{ action: 'get_image_key' }, { action: 'get_db_key', accountId: '../bad' }, { action: 'get_db_key', dbPath: '\0' }]) {
    assert.equal((await f.invoke(request)).success, false)
  }
  assert.equal(f.state.spawns.length, 0)
})

test('fragmented NDJSON follows the original protocol and returns only allowlisted fields', async () => {
  const f = fixture(child => {
    child.stderr.write(SECRET)
    const progress = line({ type: 'progress', message: `${SECRET} ${KEY}`, level: 3 })
    child.stdout.write(progress.slice(0, 9)); child.stdout.write(progress.slice(9))
    child.stdout.write(progress)
    const result = line({ type: 'result', success: true, key: KEY, accountId: 'wxid_synthetic', logs: [SECRET], arbitrary: SECRET })
    child.stdout.write(result.slice(0, 30)); child.stdout.write(result.slice(30))
    child.stdout.write(line({ type: 'result', success: true, key: 'ff'.repeat(32) }))
  })
  const result = await f.invoke({ action: 'get_db_key', dbPath: 'C:/synthetic/db_storage', accountId: 'wxid_synthetic', ignoredSecret: SECRET })
  assert.deepEqual(result, { success: true, key: KEY.toLowerCase(), accountId: 'wxid_synthetic' })
  assert.deepEqual(f.state.spawns, [[providerPath, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]])
  assert.deepEqual(JSON.parse(f.state.payload), { action: 'get_db_key', dbPath: 'C:/synthetic/db_storage', accountId: 'wxid_synthetic' })
  assert.equal(f.state.payload.endsWith('\n'), true)
  assert.equal(f.state.progress.length, 1)
  assert.equal(f.state.progress[0].includes(SECRET), false)
  assert.equal(f.state.progress[0].includes(KEY), false)
  assert.deepEqual(f.state.kills, ['SIGKILL'])
})

test('provider failure never echoes its error, logs, or stderr', async () => {
  const f = fixture(child => {
    child.stderr.write(`${SECRET} ${KEY}`)
    child.stdout.write(line({ type: 'progress', message: SECRET }))
    child.stdout.write(line({ type: 'result', success: false, key: KEY, error: SECRET, logs: [SECRET] }))
  })
  const result = await f.invoke()
  assert.equal(result.success, false); assert.match(result.error, /未能获取密钥/)
  assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
})

test('malformed success keys and unsafe account IDs are rejected without disclosure', async () => {
  for (const row of [{ key: 'not-a-key' }, { key: KEY, accountId: '../outside' }, { key: KEY, accountId: SECRET.repeat(20) }, { key: KEY, accountId: { nested: SECRET } }, { key: KEY, success: 'true' }]) {
    const f = fixture(child => child.stdout.write(line({ type: 'result', success: true, ...row, error: SECRET })))
    const result = await f.invoke()
    assert.equal(result.success, false); assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
  }
})

test('clean exit can supply a final JSON result without newline', async () => {
  const f = fixture(child => {
    child.stdout.write(JSON.stringify({ type: 'result', success: true, key: KEY }))
    child.emit('close', 0)
  })
  assert.deepEqual(await f.invoke(), { success: true, key: KEY.toLowerCase() })
  assert.deepEqual(f.state.kills, ['SIGKILL'])
})

test('empty clean exit and nonzero exit report fixed diagnostic causes', async () => {
  for (const code of [0, 7]) {
    const f = fixture(child => {
      child.stderr.write(`${SECRET} ${KEY}`)
      child.stdout.write(code ? JSON.stringify({ type: 'result', success: true, key: KEY }) : 'not-json\n')
      child.emit('close', code)
    })
    const result = await f.invoke()
    assert.equal(result.success, false)
    assert.match(result.error, code ? /异常退出/ : /未返回有效结果/)
    assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
  }
})

test('short injected timeout terminates a component that never returns', async () => {
  const f = fixture(child => child.stderr.write(SECRET))
  const result = await f.invoke(undefined, undefined, 20)
  assert.equal(result.success, false); assert.match(result.error, /超时/)
  assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
})

test('cancellation before spawn and during execution cannot return a candidate key', async () => {
  const before = new AbortController(); before.abort()
  const f = fixture()
  assert.match((await f.invoke(undefined, before)).error, /取消/)
  assert.equal(f.state.spawns.length, 0)
  const during = new AbortController()
  const g = fixture(child => { during.abort(); child.stdout.write(line({ type: 'result', success: true, key: KEY })) })
  const result = await g.invoke(undefined, during)
  assert.equal(result.success, false); assert.match(result.error, /取消/)
  assert.deepEqual(g.state.kills, ['SIGKILL']); noLeak(result, g.state)
})

test('bounded line buffer and combined stderr/stdout byte budget stop flooding', async () => {
  for (const behavior of [
    child => child.stdout.write('x'.repeat(64 * 1024 + 1)),
    child => child.stderr.write(Buffer.alloc(2 * 1024 * 1024 + 1)),
    child => { child.stderr.write(Buffer.alloc(1024 * 1024)); child.stdout.write('\n'.repeat(1024 * 1024 + 1)) }
  ]) {
    const f = fixture(behavior)
    const result = await f.invoke()
    assert.equal(result.success, false); assert.match(result.error, /超过限制/)
    assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
  }
})

test('spawn, input pipe, and output pipe errors return fixed messages', async () => {
  const fixtures = [
    fixture(undefined, { throwSpawn: true }),
    fixture(child => child.emit('error', new Error(SECRET))),
    fixture(child => child.stdin.emit('error', new Error(SECRET))),
    fixture(child => child.stdout.emit('error', new Error(SECRET))),
    fixture(child => child.stderr.emit('error', new Error(SECRET)))
  ]
  for (const f of fixtures) {
    const result = await f.invoke()
    assert.equal(result.success, false); noLeak(result, f.state)
    assert.equal(f.state.kills.length, f === fixtures[0] ? 0 : 1)
  }
})

test('a failing progress callback cannot strand the component or leak its exception', async () => {
  const f = fixture(child => child.stdout.write(line({ type: 'progress', message: SECRET })))
  const result = await f.invoke(undefined, undefined, undefined, undefined, () => { throw new Error(SECRET) })
  assert.equal(result.success, false); assert.match(result.error, /进度处理失败/)
  assert.deepEqual(f.state.kills, ['SIGKILL']); noLeak(result, f.state)
})
