// Executes the production browser-worker bundle in an isolated Node worker.
// Synthetic records only. This measures scheduling, not browser frame rate.
const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { fixture } = require('./benchmark-analysis.cjs')
const assets = path.resolve(__dirname, '../caseboard-dist/assets')
const bundle = path.join(assets, fs.readdirSync(assets).find(name => /^analysis\.worker-.*\.js$/.test(name)) || 'missing-worker')
const data = fixture(50000)
const worker = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
globalThis.self = { postMessage: value => parentPort.postMessage(value) };
require('node:vm').runInThisContext(require('node:fs').readFileSync(workerData.bundle, 'utf8'), { filename: workerData.bundle });
parentPort.on('message', data => self.onmessage({ data }));
`, { eval: true, workerData: { bundle } })
let id = 0
const requests = new Map()
worker.on('message', message => {
  const job = requests.get(message.id)
  if (!job) return
  requests.delete(message.id)
  if (message.error || message.superseded) job.reject(new Error(message.error || 'Superseded'))
  else job.resolve(message.result)
})
function request(action) { return new Promise((resolve, reject) => { const current = ++id; requests.set(current, { resolve, reject }); worker.postMessage({ id: current, action }) }) }
async function main() {
  const deadline = setTimeout(() => { console.error('Production analysis worker timed out'); void worker.terminate(); process.exitCode = 1 }, 30000)
  let ticks = 0, last = performance.now(), largestGap = 0
  const heartbeat = setInterval(() => { const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now; ticks++ }, 10)
  try {
    const start = performance.now()
    await request({ type: 'dataset', dataset: data })
    const ready = performance.now()
    const scope = { centerId: 'center', customAliases: { center: ['王小明', 'wxm'] }, excludedIds: [], startDate: '', endDate: '', query: '', kinds: ['direct', 'mention', 'shared-group', 'reply'], onlyPinned: false, pins: [] }
    const first = await request({ type: 'analyze', scope })
    const analyzed = performance.now()
    const searches = ['乌龙茶', '咖啡', '书店']
    for (const query of searches) await request({ type: 'analyze', scope: { ...scope, query } })
    const preview = await request({ type: 'report', scope, note: '', warnings: [] })
    if (!first.insights.relatedMessageIds.length || first.insights.relatedMessages || !preview.preview || preview.preview.length > 30000) throw new Error('Incomplete or oversized worker result')
    console.log(JSON.stringify({ syntheticMessages: data.messages.length, builtBundle: path.basename(bundle), initializeMs: Math.round(ready - start), firstAnalysisMs: Math.round(analyzed - ready), totalWithThreeSearchesAndPreviewMs: Math.round(performance.now() - start), mainThreadHeartbeatTicks: ticks, largestMainThreadHeartbeatGapMs: Math.round(largestGap), relatedMessageIds: first.insights.relatedMessageIds.length, previewCharacters: preview.preview.length, fullReportCharacters: preview.characters }))
  } finally { clearTimeout(deadline); clearInterval(heartbeat); await worker.terminate() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
