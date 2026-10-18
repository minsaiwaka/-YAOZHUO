const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
require.extensions['.ts'] = function(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  module._compile(output, filename)
}
require.extensions['.tsx'] = function(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  module._compile(output, filename)
}
require(path.join(__dirname, '../src/caseboard/analysis.test.ts'))
require(path.join(__dirname, '../src/caseboard/board-performance.test.ts'))
require(path.join(__dirname, '../src/caseboard/pixel-characters.test.ts'))

require(path.join(__dirname, '../src/caseboard/dossier-selection.test.ts'))
