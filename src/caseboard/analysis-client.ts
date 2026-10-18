export interface AnalysisTransport {
  postMessage(message: unknown): void
  addEventListener(type: 'message' | 'error', listener: (event: any) => void): void
  removeEventListener(type: 'message' | 'error', listener: (event: any) => void): void
  terminate(): void
}

/** One local background thread, with explicit completion and teardown. */
export class AnalysisClient {
  private sequence = 0
  private closed = false
  private fatal: Error | null = null
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  constructor(private transport: AnalysisTransport) {
    transport.addEventListener('message', this.message)
    transport.addEventListener('error', this.error)
  }
  private message = (event: { data: { id: number; result?: unknown; error?: string; superseded?: boolean } }) => {
    const { id, result, error, superseded } = event.data
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    if (error || superseded) {
      const failure = new Error(error || '分析條件已更新')
      if (superseded) failure.name = 'AbortError'
      request.reject(failure)
    } else request.resolve(result)
  }
  private error = () => {
    this.fatal = new Error('背景分析未能完成，請重新載入應用。')
    this.closed = true
    this.transport.removeEventListener('message', this.message)
    this.transport.removeEventListener('error', this.error)
    this.transport.terminate()
    for (const request of this.pending.values()) request.reject(this.fatal)
    this.pending.clear()
  }
  request<T>(action: unknown): Promise<T> {
    if (this.fatal) return Promise.reject(this.fatal)
    if (this.closed) return Promise.reject(Object.assign(new Error('背景分析已關閉'), { name: 'AbortError' }))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve, reject })
      try { this.transport.postMessage({ id, action }) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.transport.removeEventListener('message', this.message)
    this.transport.removeEventListener('error', this.error)
    this.transport.terminate()
    for (const request of this.pending.values()) request.reject(Object.assign(new Error('背景分析已關閉'), { name: 'AbortError' }))
    this.pending.clear()
  }
}
