/* Synthetic board geometry benchmark; does not open or read a WeChat account. */
const fs = require('node:fs')
const ts = require('typescript')
const { performance } = require('node:perf_hooks')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, filename)
const { createFrameQueue, createLabelObstacles, placeEdgeLabel } = require('../src/caseboard/board-geometry.ts')

const positions = {}
for (let index = 0; index < 1000; index++) positions[`n${index}`] = { x: index % 40 * 220 - 4400, y: Math.floor(index / 40) * 190 - 2375 }
const edges = Array.from({ length: 6000 }, (_, index) => {
  const start = positions[`n${index % 1000}`], end = positions[`n${(index * 13 + 47) % 1000}`]
  return { start, end, control: { x: (start.x + end.x) / 2 + 22, y: (start.y + end.y) / 2 - 22 } }
})

function legacyLabel({ start, end, control }) {
  const nodes = Object.entries(positions)
  const candidates = [.5, .35, .65, .25, .75].map(t => ({ x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x, y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y }))
  const clear = point => nodes.every(([, obstacle]) => Math.abs(point.x - obstacle.x) > 110 + 74 + 9 || Math.abs(point.y - obstacle.y) > 17 + 64)
  const match = candidates.find(clear)
  if (match) return match
  for (const shift of [-35, 35, -70, 70, -105, 105]) { const next = { x: candidates[0].x, y: candidates[0].y + shift }; if (clear(next)) return next }
  return candidates[0]
}

let digest = 0
function median(run) {
  const values = []
  run()
  for (let index = 0; index < 5; index++) { const start = performance.now(); run(); values.push(performance.now() - start) }
  return Number(values.sort((a, b) => a - b)[2].toFixed(3))
}
const beforeMs = median(() => { for (const edge of edges) digest += legacyLabel(edge).x })
const indexedAllMs = median(() => { const obstacles = createLabelObstacles(positions); for (const edge of edges) digest += placeEdgeLabel(edge.start, edge.control, edge.end, 220, obstacles).x })
const visibleLabelsMs = median(() => { const obstacles = createLabelObstacles(positions); for (const edge of edges.slice(0, 3)) digest += placeEdgeLabel(edge.start, edge.control, edge.end, 220, obstacles).x })

let pending, requests = 0, commits = 0, lastPoint = 0
const queue = createFrameQueue(point => { commits++; lastPoint = point }, callback => { pending = callback; return ++requests }, () => { pending = undefined })
for (let frame = 0; frame < 120; frame++) {
  for (let point = 0; point < 10; point++) queue.push(frame * 10 + point)
  pending()
}
process.stdout.write(JSON.stringify({ synthetic: true, nodes: 1000, edges: 6000, iterations: 5, medianMs: { previousAllLabels: beforeMs, indexedAllLabels: indexedAllMs, currentThreeVisibleLabels: visibleLabelsMs }, inputBurst: { pointerEvents: 1200, frames: 120, reactUpdatesBefore: 1200, queuedUpdates: commits, finalPoint: lastPoint }, digest }, null, 2) + '\n')
