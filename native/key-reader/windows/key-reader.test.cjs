// Windows-only native smoke checks. Never runs the real WeChat scan mode with
// valid input: --self-test reads only this helper's own synthetic allocations.
// node --test native/key-reader/windows/key-reader.test.cjs
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const windows = process.platform === 'win32'
const projectRoot = path.resolve(__dirname, '../../..')
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
let outputFolder
let executable

function compile() {
  if (executable) return executable
  const workRoot = path.resolve(projectRoot, '.tmp/test-work')
  fs.mkdirSync(workRoot, { recursive: true })
  outputFolder = fs.mkdtempSync(path.join(workRoot, 'key-reader-native-test-'))
  executable = path.join(outputFolder, 'KeyReader.exe')
  const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:anycpu', '/langversion:5', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', `/out:${executable}`, path.join(__dirname, 'KeyReader.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, `C#5 compile failed: ${result.stdout}\n${result.stderr}`)
  return executable
}

function run(args, input = '') {
  return spawnSync(compile(), args, { input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
}

after(() => {
  if (!outputFolder) return
  const workRoot = path.resolve(projectRoot, '.tmp/test-work')
  const rel = path.relative(workRoot, outputFolder)
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  fs.rmSync(outputFolder, { recursive: true, force: true, maxRetries: 3 })
})

test('C#5 AnyCPU helper exercises ASCII/UTF16 and real pointer reads against its own synthetic memory only', { skip: !windows }, () => {
  const result = run(['--self-test'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(lines.length, 1)
  const report = lines[0]
  assert.equal(report.type, 'self-test')
  assert.equal(report.success, true)
  assert.equal(report.architecture, 64)
  assert.equal(report.candidates, 4)
  for (const property of ['memoryRead', 'ascii96', 'utf16', 'keyOnly', 'pointer32', 'entropyFilter', 'deduplicated', 'profileProtection']) assert.equal(report[property], true, property)
  assert.equal(/\b[\da-f]{64}\b/i.test(result.stdout), false, 'self-test must never print key material')
  assert.equal(result.stdout.includes('"key"'), false)
})

test('invalid and over-64KB stdin is rejected before any process is enumerated', { skip: !windows }, () => {
  const cases = [
    ['', 'INPUT_INVALID'],
    ['{broken', 'INPUT_INVALID'],
    [JSON.stringify({ salts: [] }), 'INPUT_INVALID'],
    [JSON.stringify({ salts: ['not-a-salt'] }), 'INPUT_INVALID'],
    [JSON.stringify({ salts: [123] }), 'INPUT_INVALID'],
    [JSON.stringify({ salts: ['0'.repeat(32)], unexpected: 'x' }), 'INPUT_INVALID'],
    [' '.repeat(64 * 1024 + 1), 'INPUT_TOO_LARGE'],
  ]
  for (const [input, code] of cases) {
    const result = run([], input)
    assert.equal(result.status, 2)
    assert.equal(result.stderr.trim(), code)
    assert.deepEqual(JSON.parse(result.stdout), { type: 'complete', processes: 0, candidates: 0, denied: false, limited: false })
  }
})

test('unknown flags produce a fixed code and no scan progress or candidates', { skip: !windows }, () => {
  const result = run(['--unknown'])
  assert.equal(result.status, 2)
  assert.equal(result.stderr.trim(), 'ARGUMENT_INVALID')
  assert.deepEqual(JSON.parse(result.stdout), { type: 'complete', processes: 0, candidates: 0, denied: false, limited: false })
})

test('profile mode rejects an arbitrary target argument before reading any saved profile', { skip: !windows }, () => {
  const result = run(['--weflow-profile-key', 'C:/another-profile/Local State'])
  assert.equal(result.status, 2)
  assert.equal(result.stderr.trim(), 'ARGUMENT_INVALID')
  assert.deepEqual(JSON.parse(result.stdout), { type: 'complete', processes: 0, candidates: 0, denied: false, limited: false })
})

test('diagnostic mode returns only aggregate process and user-match metadata', { skip: !windows }, () => {
  const result = run(['--diagnose'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 1)
  const report = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(report).sort(), ['accessibleProcesses', 'denied', 'differentUserProcesses', 'processes', 'sameUserProcesses', 'type'].sort())
  assert.equal(report.type, 'diagnostic')
  for (const key of ['processes', 'accessibleProcesses', 'sameUserProcesses', 'differentUserProcesses']) assert.ok(Number.isSafeInteger(report[key]) && report[key] >= 0)
  assert.ok(report.accessibleProcesses <= report.processes)
  assert.ok(report.sameUserProcesses + report.differentUserProcesses <= report.accessibleProcesses)
  assert.equal(typeof report.denied, 'boolean')
  assert.equal(/(?:S-1-\d-|"key"|"pid"|"sid"|"username")/i.test(result.stdout), false)
  const source = fs.readFileSync(path.join(__dirname, 'KeyReader.cs'), 'utf8')
  const diagnostic = source.slice(source.indexOf('private static int Diagnose()'), source.indexOf('private static void ScanProcess'))
  assert.match(diagnostic, /OpenProcess\(ProcessQueryLimitedInformation, false, pid\)/)
  assert.equal(/(?:ReadProcessMemory|VirtualQueryEx|ScanProcess\(|ProcessQueryAndRead)/.test(diagnostic), false)
})

test('diagnostic mode rejects extra arguments before process enumeration', { skip: !windows }, () => {
  const result = run(['--diagnose', '--scan'])
  assert.equal(result.status, 2)
  assert.equal(result.stderr.trim(), 'ARGUMENT_INVALID')
  assert.deepEqual(JSON.parse(result.stdout), { type: 'complete', processes: 0, candidates: 0, denied: false, limited: false })
})
