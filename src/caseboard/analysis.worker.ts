import { AnalysisRuntime, type AnalysisAction } from './analysis-runtime'

const runtime = new AnalysisRuntime()
const scope = self as unknown as { onmessage: (event: MessageEvent<{ id: number; action: AnalysisAction }>) => void; postMessage(value: unknown): void }
let latest: { id: number; action: AnalysisAction } | null = null
let scheduled = false
async function run(message: { id: number; action: AnalysisAction }) {
  try { scope.postMessage({ id: message.id, result: await runtime.handle(message.action) }) }
  catch (error) { scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : '背景分析未能完成' }) }
}
scope.onmessage = event => {
  const message = event.data
  if (message.action.type !== 'analyze') { void run(message); return }
  if (latest) scope.postMessage({ id: latest.id, superseded: true })
  latest = message
  if (!scheduled) {
    scheduled = true
    setTimeout(() => { scheduled = false; const next = latest; latest = null; if (next) void run(next) }, 0)
  }
}
