import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeArchiveService } from './native-client'
import { generateSummary } from './ai-client'
import type { AISummaryOptions, ConnectionOptions, Evidence, LoadOptions, NativeOpenOptions, NativeAutoOptions } from '../../src/caseboard/types'

const PREFIX = '/caseboard-api'
const MAX_BODY_BYTES = 64 * 1024 * 1024
class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) return Promise.reject(new ApiError(499, '任务已取消'))
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) { request.resume(); return Promise.reject(new ApiError(413, '请求内容超过 64 MB')) }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let finished = false
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('aborted', disconnected); request.off('error', disconnected)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); request.resume(); reject(error) }
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) { fail(new ApiError(413, '请求内容超过 64 MB')); return }
      chunks.push(chunk)
    }
    const end = () => {
      if (finished) return
      finished = true; cleanup()
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolve(value as Record<string, unknown>)
      } catch { reject(new ApiError(400, '请求必须包含有效的 JSON 对象')) }
    }
    const abort = () => fail(new ApiError(499, '任务已取消'))
    const disconnected = () => fail(new ApiError(499, '客户端连接已断开'))
    request.on('data', data); request.once('end', end); request.once('aborted', disconnected); request.once('error', disconnected)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isLoopback(address: string): boolean {
  return address === '::1' || /^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/i.test(address)
}

/** Vite middleware only. The caller must bind its HTTP listener to 127.0.0.1. */
export function createCaseboardApi(origin: string, archive: Pick<NativeArchiveService, 'discover' | 'autoSetup' | 'open' | 'load' | 'media' | 'close' | 'dispose'>): { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>; close(): void } {
  const configured = new URL(origin)
  if (configured.protocol !== 'http:' || configured.hostname !== '127.0.0.1' || configured.username || configured.password || configured.search || configured.hash || configured.pathname !== '/') {
    throw new Error('本地预览 API 只支持绑定 http://127.0.0.1 的开发服务')
  }
  const expectedOrigin = configured.origin
  const connections = new Set<ServerResponse>()
  const controllers = new Set<AbortController>()
  let activeLoad: AbortController | null = null
  let activeSummary: AbortController | null = null
  let closed = false

  const progress = (type: 'load' | 'summary', payload: unknown) => {
    const event = `data: ${JSON.stringify({ type, payload })}\n\n`
    for (const response of connections) {
      if (response.destroyed || response.writableEnded || response.writableLength > 1024 * 1024) { response.end(); connections.delete(response) }
      else response.write(event)
    }
  }
  const sameReferrer = (value: unknown) => {
    try { return typeof value === 'string' && new URL(value).origin === expectedOrigin } catch { return false }
  }

  return {
    async handle(request, response) {
      let url: URL
      try { url = new URL(request.url || '/', expectedOrigin) } catch { return false }
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false
      let body: Record<string, unknown> | undefined
      let controller: AbortController | undefined
      let disconnect: (() => void) | undefined
      const action = url.pathname.slice(PREFIX.length + 1)
      try {
        if (closed) throw new ApiError(503, '本地预览 API 已关闭')
        if (request.headers.host !== configured.host || url.origin !== expectedOrigin || !isLoopback(request.socket.remoteAddress || '')) throw new ApiError(403, '仅接受当前本机预览服务的请求')
        if (url.search) throw new ApiError(400, 'API 参数须放入 JSON 请求体')
        if (action === 'events') {
          if (request.method !== 'GET') throw new ApiError(405, '事件订阅仅接受 GET')
          const suppliedOrigin = request.headers.origin
          const fetchSite = request.headers['sec-fetch-site']
          if ((suppliedOrigin !== undefined && suppliedOrigin !== expectedOrigin) || (fetchSite !== undefined && fetchSite !== 'same-origin') || (!suppliedOrigin && fetchSite !== 'same-origin' && !sameReferrer(request.headers.referer))) throw new ApiError(403, '事件订阅必须来自当前预览页面')
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' })
          response.flushHeaders()
          response.write(': connected\n\n')
          connections.add(response)
          const timer = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n') }, 20_000)
          timer.unref()
          response.once('close', () => { clearInterval(timer); connections.delete(response) })
          return true
        }
        if (request.method !== 'POST') throw new ApiError(405, '本地 API 仅接受 POST JSON 请求')
        if (request.headers.origin !== expectedOrigin) throw new ApiError(403, '请求必须来自当前预览页面')
        if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Content-Type 必须为 application/json')
        if (!['discover', 'auto-setup', 'catalog', 'load', 'media', 'close-connection', 'summary', 'cancel-load', 'cancel-summary'].includes(action)) throw new ApiError(404, '本地 API 不存在')
        if (['load', 'catalog', 'auto-setup'].includes(action) && activeLoad) throw new ApiError(409, '已有读取任务，请等待完成或先取消')
        if (action === 'summary' && activeSummary) throw new ApiError(409, '已有 AI 整理任务，请等待完成或先取消')
        controller = new AbortController()
        controllers.add(controller)
        if (['load', 'catalog', 'auto-setup'].includes(action)) activeLoad = controller
        if (action === 'summary') activeSummary = controller
        // IncomingMessage.close also fires when a normal POST body finishes. Only
        // an unfinished response closing is a client disconnect that cancels work.
        disconnect = () => { if (!response.writableEnded) controller?.abort() }
        response.once('close', disconnect)
        body = await readBody(request, controller.signal)
        let result: unknown
        if (action === 'discover') result = await archive.discover()
        else if (action === 'auto-setup') result = await archive.autoSetup(body as unknown as NativeAutoOptions, controller.signal, value => progress('load', value))
        else if (action === 'catalog') result = await archive.open(body as unknown as NativeOpenOptions, controller.signal, value => progress('load', value))
        else if (action === 'load') result = await archive.load(body as unknown as LoadOptions, controller.signal, value => progress('load', value))
        else if (action === 'media') result = await archive.media(body as unknown as ConnectionOptions & { evidence: Evidence })
        else if (action === 'close-connection') { await archive.close(body as unknown as ConnectionOptions); result = { closed: true } }
        else if (action === 'summary') result = await generateSummary(body as unknown as AISummaryOptions, controller.signal, value => progress('summary', value))
        else if (action === 'cancel-load') { activeLoad?.abort(); result = { cancelled: true } }
        else { activeSummary?.abort(); result = { cancelled: true } }
        json(response, 200, result)
      } catch (error) {
        let message = error instanceof Error ? error.message : '本地 API 未能完成请求'
        // Existing clients produce safe errors; redact credentials defensively if a
        // future upstream implementation accidentally embeds one in an error string.
        for (const field of ['token', 'apiKey', 'key', 'imageKey']) {
          const secret = body?.[field]
          if (typeof secret === 'string' && secret) message = message.split(secret).join('[已隐藏]')
        }
        if (body?.keys && typeof body.keys === 'object') for (const secret of Object.values(body.keys)) if (typeof secret === 'string' && secret) message = message.split(secret).join('[已隐藏]')
        json(response, error instanceof ApiError ? error.status : 400, { error: message })
      } finally {
        if (controller) {
          controllers.delete(controller)
          if (activeLoad === controller) activeLoad = null
          if (activeSummary === controller) activeSummary = null
        }
        if (disconnect) response.off('close', disconnect)
      }
      return true
    },
    close() {
      closed = true
      for (const controller of controllers) controller.abort()
      for (const response of connections) response.end()
      connections.clear()
      void archive.dispose()
    },
  }
}
