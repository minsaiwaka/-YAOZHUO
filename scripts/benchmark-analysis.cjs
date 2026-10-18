// Synthetic only. Run with Node; no account files, messages or keys are read.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { performance } = require('node:perf_hooks')
require.extensions['.ts'] = function(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  module.paths.push(path.resolve(__dirname, '../node_modules'))
  module._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename)
}
function fixture(count) {
  const people = [{ id: 'me', name: '我', kind: 'self' }, { id: 'center', name: '王小明', kind: 'person' }]
  const surnames = ['陈', '林', '周', '李', '赵', '吴', '郑', '杨', '朱', '张']
  for (let i = 0; i < 500; i++) people.push({ id: `person-${i}`, name: `${surnames[i % 10]}${['景', '文', '子', '知', '晓'][Math.floor(i / 10) % 5]}${['明', '雨', '阳', '云', '青', '华', '海', '安', '宁', '乐'][Math.floor(i / 50)]}`, kind: 'person' })
  for (let i = 0; i < 20; i++) people.push({ id: `group-${i}`, name: `摄影读书群 ${i}`, kind: 'group' })
  const messages = Array.from({ length: count }, (_, i) => {
    const sessionId = i % 5 === 0 ? 'center' : i % 3 === 0 ? `group-${i % 20}` : `person-${i % 500}`
    const senderId = i % 2 ? 'me' : i % 5 === 0 ? 'center' : `person-${i % 500}`
    return { id: `message-${i}`, sessionId, sessionName: sessionId, senderId, senderName: senderId, kind: 'text', timestamp: 1735689600000 + i * 1000, content: `${i % 37 === 0 ? '王小明 wxm ' : ''}${['周末去旧书店看看摄影画册和咖啡。', '下班以后一起喝乌龙茶，顺便聊聊新电影。', '明天讨论项目计划，午饭想吃面条。', '周末活动取消了，等有空再去书店。'][i % 4]} ${i}`, ...(i % 23 === 0 && i > 0 ? { replyTo: `message-${i - 1}` } : {}) }
  })
  const memberships = []
  for (let i = 0; i < 20; i++) for (let j = 0; j < 50; j++) memberships.push({ personId: j === 0 ? 'center' : `person-${(i * 23 + j) % 500}`, groupId: `group-${i}` })
  return { schemaVersion: 1, id: `benchmark-${count}`, title: 'Synthetic benchmark', source: 'demo', importedAt: 0, ownerId: 'me', people, messages, memberships, coverage: { partial: false, messageCount: count, sessionCount: 521, description: 'Synthetic', warnings: [] } }
}
function elapsed(fn) { const start = performance.now(); const result = fn(); return { ms: Math.round((performance.now() - start) * 10) / 10, result } }
if (require.main === module) for (const count of [10000, 50000]) {
  const analysis = require(path.resolve(process.argv[2] || 'src/caseboard/analysis.ts'))
  const data = fixture(count)
  const aliases = { center: ['王小明', 'wxm'] }
  const index = elapsed(() => analysis.createAnalysisEngine?.(data))
  const engine = index.result
  const analyze = engine ? () => engine.analyze('center', aliases) : () => analysis.analyzePerson(data, 'center', aliases)
  const graph = engine ? filters => engine.graph('center', filters, aliases) : filters => analysis.buildGraph(data, 'center', filters, aliases)
  const insights = elapsed(analyze)
  const board = elapsed(() => graph({}))
  const search = elapsed(() => graph({ query: '乌龙茶' }))
  const repeated = elapsed(() => { for (let i = 0; i < 5; i++) { analyze(); graph({}); graph({ query: '乌龙茶' }); graph({ kinds: ['mention'] }) } })
  console.log(JSON.stringify({ count, contacts: data.people.length, indexMs: index.ms, analyzeMs: insights.ms, graphMs: board.ms, searchMs: search.ms, repeat20RequestsMs: repeated.ms, related: insights.result.relatedMessages.length, hits: insights.result.hits.length, edges: board.result.edges.length, topics: insights.result.topics.map(topic => [topic.label, topic.count]) }))
}
module.exports = { fixture }
