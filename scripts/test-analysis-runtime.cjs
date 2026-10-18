const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = function(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText
  module._compile(output, filename)
}
require(path.join(__dirname, '../src/caseboard/analysis-runtime.test.ts'))
