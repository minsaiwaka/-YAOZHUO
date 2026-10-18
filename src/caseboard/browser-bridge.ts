import type { CaseboardBridge } from './types'

// The browser preview uses the same local adapters as the Electron IPC entry.
if (!window.caseboard && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  const connectionIds = new Set<string>()
  let clientId = crypto.randomUUID()
  try { const saved = sessionStorage.getItem('yaozhuo-native-tab'); if (saved && /^[\w-]{1,100}$/.test(saved)) clientId = saved as typeof clientId; else sessionStorage.setItem('yaozhuo-native-tab', clientId) } catch { /* Closing below still releases sessions when session storage is unavailable. */ }
  async function request<T>(route: string, options: unknown = {}): Promise<T> {
    let response: Response
    try { response = await fetch(`/caseboard-api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options), credentials: 'same-origin', redirect: 'error' }) }
    catch { throw new Error('本地服务未连接，请确认开发服务仍在运行。') }
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error || `本地服务返回 ${response.status}`)
    return result as T
  }
  let events: EventSource | null = null
  const loadListeners = new Set<(value: Parameters<Parameters<CaseboardBridge['onProgress']>[0]>[0]) => void>()
  const summaryListeners = new Set<(value: Parameters<Parameters<CaseboardBridge['onSummaryProgress']>[0]>[0]) => void>()
  function connectEvents() {
    if (events) return
    events = new EventSource('/caseboard-api/events')
    events.onmessage = event => {
      try { const value = JSON.parse(event.data); if (value.type === 'load') for (const listener of loadListeners) listener(value.payload); if (value.type === 'summary') for (const listener of summaryListeners) listener(value.payload) } catch { /* Ignore malformed progress, never interpret it as an action. */ }
    }
  }
  function closeEvents() { if (!loadListeners.size && !summaryListeners.size) { events?.close(); events = null } }
  window.caseboard = {
    discover: () => request('discover'),
    autoSetup: options => request('auto-setup', options),
    chooseFolder: async () => ({}),
    async closeConnection(options) { try { await request('close-connection', options) } finally { connectionIds.delete(options.connectionId) } },
    async catalog(options) { const result = await request<Awaited<ReturnType<CaseboardBridge['catalog']>>>('catalog', { ...options, clientId }); connectionIds.clear(); connectionIds.add(result.connectionId); return result },
    load: options => request('load', options),
    cancelLoad: () => request('cancel-load'),
    media: options => request('media', options),
    summarize: options => request('summary', options),
    cancelSummary: () => request('cancel-summary'),
    onProgress(callback) { loadListeners.add(callback); connectEvents(); return () => { loadListeners.delete(callback); closeEvents() } },
    onSummaryProgress(callback) { summaryListeners.add(callback); connectEvents(); return () => { summaryListeners.delete(callback); closeEvents() } },
    async saveFile({ name, content, extension }) {
      const url = URL.createObjectURL(new Blob([content], { type: extension === 'json' ? 'application/json;charset=utf-8' : extension === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      return { saved: true, path: `已发起浏览器下载：${name}` }
    },
  } satisfies CaseboardBridge
  window.addEventListener('pagehide', () => {
    events?.close()
    for (const connectionId of connectionIds) void fetch('/caseboard-api/close-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId }), credentials: 'same-origin', keepalive: true, redirect: 'error' }).catch(() => {})
    connectionIds.clear()
  })
}
