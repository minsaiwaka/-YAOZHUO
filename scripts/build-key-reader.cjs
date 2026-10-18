const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'resources/caseboard/key-reader', process.platform)
fs.mkdirSync(output, { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.status !== 0) { process.stderr.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw new Error('内置密钥读取器构建失败') }
}
if (process.platform === 'win32') {
  const csc = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  if (!fs.existsSync(csc)) throw new Error('构建 Windows 密钥读取器需要 .NET Framework 4.x 编译器')
  run(csc, ['/nologo', '/optimize+', '/platform:anycpu', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', `/out:${path.join(output, 'yaozhuo-key-reader.exe')}`, path.join(root, 'native/key-reader/windows/KeyReader.cs')])
  run(path.join(output, 'yaozhuo-key-reader.exe'), ['--self-test'])
} else if (process.platform === 'darwin') {
  const helper = path.join(output, 'yaozhuo-key-reader')
  run('xcrun', ['--sdk', 'macosx', 'clang', '-O2', '-fobjc-arc', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0', '-framework', 'Foundation', path.join(root, 'native/key-reader/macos/key-reader.m'), '-o', helper])
  run('lipo', ['-archs', helper])
  run('codesign', ['--force', '--sign', '-', helper])
  run(helper, ['--self-test'])
} else { process.stdout.write('自动密钥读取器目前仅适配 Windows 与 macOS。\n') }
