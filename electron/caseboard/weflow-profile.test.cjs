// Saved-profile compatibility uses synthetic files and keys only. Never invokes
// the fixed real-profile helper mode or reads the user's actual WeFlow files.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '../..')
const workRoot = path.resolve(projectRoot, '.tmp/test-work')
fs.mkdirSync(workRoot, { recursive: true })
const suiteRoot = fs.mkdtempSync(path.join(workRoot, 'weflow-profile-test-'))
const filename = path.join(__dirname, 'weflow-profile.ts')
fs.writeFileSync(path.join(suiteRoot, 'weflow-profile.js'), ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename }).outputText)
const { discoverWeFlowRoots, loadWeFlowKeys } = require(path.join(suiteRoot, 'weflow-profile.js'))
const databaseKey = crypto.createHash('sha256').update('synthetic profile database key').digest('hex')
const otherKey = crypto.createHash('sha256').update('different synthetic account key').digest('hex')
let next = 0

function fixture(config = {}) {
  const root = path.join(suiteRoot, `fixture-${++next}`)
  const dbRoot = path.join(root, 'xwechat_files')
  const account = path.join(dbRoot, 'wxid_profile_owner_ab12')
  const profile = path.join(root, 'WeFlow', 'WeFlow-config.json')
  fs.mkdirSync(account, { recursive: true })
  fs.mkdirSync(path.dirname(profile), { recursive: true })
  fs.writeFileSync(profile, JSON.stringify({ dbPath: dbRoot, ...config }))
  return { root, dbRoot, account, profile, options: { configPaths: [profile], platform: 'win32', signal: new AbortController().signal } }
}
function v10(keyText, master) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', master, nonce)
  return 'safe:' + Buffer.concat([Buffer.from('v10'), nonce, cipher.update(keyText), cipher.final(), cipher.getAuthTag()]).toString('base64')
}
function digest(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }

after(() => {
  const rel = path.relative(workRoot, suiteRoot)
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 3 })
})

test('discovery reads a saved non-default dbPath without decoding any protected values or writing settings', async () => {
  const f = fixture({ decryptKey: 'safe:unreadable', myWxid: 'wxid_profile_owner' })
  const before = digest(f.profile)
  const info = fs.statSync(f.profile)
  assert.deepEqual(await discoverWeFlowRoots({ appData: f.root, platform: 'win32' }), [f.dbRoot])
  assert.equal(digest(f.profile), before)
  assert.equal(fs.statSync(f.profile).mtimeMs, info.mtimeMs)
  assert.deepEqual(await discoverWeFlowRoots({ configPaths: [] }), [])
})

test('malformed, oversized and relative-root profiles are ignored', async () => {
  const f = fixture()
  const broken = path.join(f.root, 'broken.json'), relative = path.join(f.root, 'relative.json'), oversized = path.join(f.root, 'oversized.json')
  fs.writeFileSync(broken, '{broken')
  fs.writeFileSync(relative, JSON.stringify({ dbPath: '../somewhere' }))
  fs.writeFileSync(oversized, ' '.repeat(2 * 1024 * 1024 + 1))
  assert.deepEqual(await discoverWeFlowRoots({ configPaths: [broken, relative, oversized] }), [])
})

test('an explicit wxid that ends in four characters keeps those characters', async () => {
  const f = fixture({ myWxid: 'wxid_abcd', decryptKey: databaseKey })
  const account = path.join(f.dbRoot, 'wxid_abcd_xy12')
  fs.mkdirSync(account)
  const result = await loadWeFlowKeys(account, f.options)
  assert.deepEqual(result.candidates, [{ key: databaseKey }])
  assert.equal(result.ownerId, 'wxid_abcd')
})

test('legacy myWxid and plaintext saved keys are matched to the selected account only', async () => {
  const f = fixture({ myWxid: 'wxid_profile_owner', decryptKey: databaseKey, aiModelApiKey: otherKey })
  const before = digest(f.profile)
  const result = await loadWeFlowKeys(f.account, f.options)
  assert.deepEqual(result, { candidates: [{ key: databaseKey }], ownerId: 'wxid_profile_owner', warnings: [] })
  assert.equal(digest(f.profile), before)
})

test('saved image AES and protected XOR restore only for the selected account, preserving case and XOR zero', async () => {
  const image = 'SyntheticImage16'
  const master = crypto.randomBytes(32)
  const f = fixture({ myAccountId: 'wxid_other_owner', imageAesKey: 'WrongAccount1234', accountConfigs: { wxid_profile_owner: { decryptKey: databaseKey, imageAesKey: v10(image, master), imageXorKey: v10('0', master) }, wxid_other_owner: { imageAesKey: 'WrongAccount1234', imageXorKey: 95 } } })
  const result = await loadWeFlowKeys(f.account, { ...f.options, storageKeyProvider: async () => master })
  assert.deepEqual(result.mediaCandidates, [{ imageKey: image, xorKey: 0 }])
  assert.deepEqual(result.candidates, [{ key: databaseKey }])
  assert.equal(master.every(byte => byte === 0), true)
  assert.equal(JSON.stringify(result).includes('WrongAccount1234'), false)
})

test('accountConfigs selects a matching account while ignoring another current global account', async () => {
  const f = fixture({ myAccountId: 'wxid_other_owner', decryptKey: otherKey, accountConfigs: { wxid_other_owner: { decryptKey: otherKey }, wxid_profile_owner: { decryptKey: databaseKey }, unknown: { decryptKey: otherKey } } })
  const result = await loadWeFlowKeys(f.account, f.options)
  assert.deepEqual(result.candidates, [{ key: databaseKey }])
  assert.equal(result.ownerId, 'wxid_profile_owner')
  assert.deepEqual(result.warnings, [])
})

test('an account outside the saved dbPath cannot load or decrypt profile keys', async () => {
  const f = fixture({ decryptKey: 'safe:' + Buffer.from('synthetic protected').toString('base64') })
  const outside = path.join(f.root, 'outside', path.basename(f.account))
  fs.mkdirSync(outside, { recursive: true })
  let decoded = 0
  const result = await loadWeFlowKeys(outside, { ...f.options, decryptProtected: () => { decoded++; return databaseKey }, storageKeyProvider: async () => { decoded++; return Buffer.alloc(32) } })
  assert.deepEqual(result, { candidates: [], warnings: [] })
  assert.equal(decoded, 0)
})

test('a directory junction that escapes the saved root cannot load saved keys', async t => {
  const f = fixture({ decryptKey: databaseKey })
  const outside = path.join(f.root, 'other-data', path.basename(f.account)), link = path.join(f.dbRoot, 'linked-account')
  fs.mkdirSync(outside, { recursive: true })
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') { t.skip('directory links unavailable on this host'); return } throw error }
  assert.deepEqual(await loadWeFlowKeys(link, f.options), { candidates: [], warnings: [] })
})

test('only an existing absolute saved provider path is returned, without executing it', async () => {
  const f = fixture()
  const provider = path.join(f.root, 'synthetic-provider.exe')
  fs.writeFileSync(provider, 'This is a synthetic data file and must never be executed.')
  fs.writeFileSync(f.profile, JSON.stringify({ dbPath: f.dbRoot, keyProviderPath: provider }))
  const result = await loadWeFlowKeys(f.account, f.options)
  assert.equal(result.providerPath, fs.realpathSync(provider))
  assert.deepEqual(result.candidates, [])
  fs.writeFileSync(f.profile, JSON.stringify({ dbPath: f.dbRoot, keyProviderPath: './synthetic-provider.exe' }))
  assert.equal((await loadWeFlowKeys(f.account, f.options)).providerPath, undefined)
  fs.writeFileSync(f.profile, JSON.stringify({ dbPath: f.dbRoot, keyProviderPath: f.root }))
  assert.equal((await loadWeFlowKeys(f.account, f.options)).providerPath, undefined)
})

test('Windows v10 AES-GCM saved database keys decrypt in memory and wipe the injected storage-key buffer', async () => {
  const master = crypto.randomBytes(32)
  const stored = v10(databaseKey, master)
  const f = fixture({ myWxid: 'wxid_profile_owner', decryptKey: stored, accountConfigs: { wxid_profile_owner: { decryptKey: stored } } })
  const before = digest(f.profile)
  let calls = 0
  const result = await loadWeFlowKeys(f.account, { ...f.options, storageKeyProvider: async () => { calls++; return master }, decryptProtected: () => { throw new Error('v10 should use its own original storage key') } })
  assert.deepEqual(result.candidates, [{ key: databaseKey }])
  assert.deepEqual(result.warnings, [])
  assert.equal(calls, 1)
  assert.equal(master.equals(Buffer.alloc(32)), true)
  assert.equal(digest(f.profile), before)
})

test('tampered v10 and password-locked values produce generic warnings without returning guessed keys', async () => {
  const master = crypto.randomBytes(32)
  const stored = v10(databaseKey, master)
  const damaged = Buffer.from(stored.slice(5), 'base64')
  damaged[damaged.length - 1] ^= 1
  const f = fixture({ decryptKey: 'safe:' + damaged.toString('base64'), accountConfigs: { wxid_profile_owner: { decryptKey: 'lock:synthetic-password-protected' } } })
  const result = await loadWeFlowKeys(f.account, { ...f.options, storageKeyProvider: async () => master })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.warnings.length, 2)
  assert.equal(JSON.stringify(result).includes(databaseKey), false)
  assert.equal(master.equals(Buffer.alloc(32)), true)
})

test('macOS and older protected payloads use supplied safeStorage and wipe ciphertext after decoding', async () => {
  const f = fixture({ decryptKey: 'safe:' + Buffer.from('synthetic macOS encrypted bytes').toString('base64') })
  let retained, calls = 0
  const result = await loadWeFlowKeys(f.account, { ...f.options, platform: 'darwin', decryptProtected: async ciphertext => { calls++; retained = ciphertext; return databaseKey } })
  assert.deepEqual(result.candidates, [{ key: databaseKey }])
  assert.equal(calls, 1)
  assert.equal(retained.every(byte => byte === 0), true)
})

test('locked or failed safeStorage payloads do not fall back to plaintext interpretations', async () => {
  const f = fixture({ decryptKey: 'lock:' + databaseKey, accountConfigs: { wxid_profile_owner: { decryptKey: 'safe:' + Buffer.from('synthetic encrypted').toString('base64') } } })
  const result = await loadWeFlowKeys(f.account, { ...f.options, platform: 'darwin', decryptProtected: () => { throw new Error('sensitive detailed error must not propagate') } })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.warnings.length, 2)
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('cancellation before or during protected-key restoration aborts without returning candidates and wipes buffers', async () => {
  const control = new AbortController()
  control.abort()
  const f = fixture({ decryptKey: databaseKey })
  await assert.rejects(loadWeFlowKeys(f.account, { ...f.options, signal: control.signal }), { name: 'AbortError' })
  const during = new AbortController(), master = crypto.randomBytes(32)
  fs.writeFileSync(f.profile, JSON.stringify({ dbPath: f.dbRoot, decryptKey: v10(databaseKey, master) }))
  await assert.rejects(loadWeFlowKeys(f.account, { ...f.options, signal: during.signal, storageKeyProvider: async () => { during.abort(); return master } }), { name: 'AbortError' })
  assert.equal(master.equals(Buffer.alloc(32)), true)
})
