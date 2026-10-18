import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export interface WeFlowProviderRequest {
  action: 'get_db_key'
  dbPath?: string
  accountId?: string
}
export interface WeFlowProviderResult {
  success: boolean
  key?: string
  accountId?: string
  error?: string
}
export interface WeFlowProviderOptions { timeoutMs?: number }

const HEX_KEY = /^[a-f\d]{64}$/i
const ACCOUNT_ID = /^[\w.@-]{1,256}$/
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_LINE = 64 * 1024
const MAX_TIMEOUT = 120_000
const failure = (error: string): WeFlowProviderResult => ({ success: false, error })

/**
 * One explicit auto-key action, using the original WeFlow NDJSON protocol.
 * Directory discovery must never call this function. The caller supplies a
 * selected, configured component; provider text and stderr never reach the UI.
 * A returned key is a candidate and must be authenticated against the chosen DB.
 */
export async function invokeWeFlowProvider(
  providerPath: string,
  request: WeFlowProviderRequest,
  signal: AbortSignal,
  progress: (message: string) => void,
  options: WeFlowProviderOptions = {}
): Promise<WeFlowProviderResult> {
  if (signal.aborted) return failure('原版密钥组件读取已取消')
  if (typeof providerPath !== 'string' || !isAbsolute(providerPath) || providerPath.length > 4096 || providerPath.includes('\0')) {
    return failure('原版密钥组件路径无效，请选择完整的可执行文件路径')
  }
  if (!request || request.action !== 'get_db_key' ||
    (request.dbPath !== undefined && (typeof request.dbPath !== 'string' || request.dbPath.length > 4096 || request.dbPath.includes('\0'))) ||
    (request.accountId !== undefined && (typeof request.accountId !== 'string' || !ACCOUNT_ID.test(request.accountId)))) {
    return failure('原版密钥组件请求参数无效')
  }
  try { if (!(await stat(providerPath)).isFile()) return failure('原版密钥组件文件不存在或无法读取') }
  catch { return failure('原版密钥组件文件不存在或无法读取') }
  if (signal.aborted) return failure('原版密钥组件读取已取消')

  const configuredTimeout = Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs!) : MAX_TIMEOUT
  const timeout = Math.min(MAX_TIMEOUT, Math.max(1, configuredTimeout))
  // Rebuild the allowlisted payload; extra object properties are never sent.
  const payload: WeFlowProviderRequest = {
    action: 'get_db_key',
    ...(request.dbPath !== undefined ? { dbPath: request.dbPath } : {}),
    ...(request.accountId !== undefined ? { accountId: request.accountId } : {})
  }
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(providerPath, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch { resolve(failure('原版密钥组件无法启动，请检查文件权限与系统架构')); return }
    let settled = false, buffered = '', bytes = 0, notified = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: WeFlowProviderResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      buffered = ''
      // This is a single-request component. Do not leave it running after a
      // result, cancellation, malformed output, timeout, or failed exit.
      try { child.kill('SIGKILL') } catch { /* No provider details are exposed. */ }
      resolve(result)
    }
    const abort = () => finish(failure('原版密钥组件读取已取消'))
    const consumeLine = (line: string) => {
      if (settled || !line.trim()) return
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const row = value as Record<string, unknown>
      if (row.type === 'progress') {
        // Emit one fixed state per invocation, even if the provider floods
        // progress events or includes credentials in its message field.
        if (!notified) {
          notified = true
          try { progress('正在通过原版微信密钥组件读取，请保持微信登录…') }
          catch { finish(failure('原版密钥组件进度处理失败，请重试')) }
        }
      } else if (row.type === 'result') {
        if (row.success !== true) { finish(failure('原版密钥组件未能获取密钥，请保持微信登录并检查组件版本')); return }
        if (typeof row.key !== 'string' || !HEX_KEY.test(row.key) ||
          (row.accountId !== undefined && (typeof row.accountId !== 'string' || !ACCOUNT_ID.test(row.accountId)))) {
          finish(failure('原版密钥组件返回格式无效，密钥未被填入')); return
        }
        finish({ success: true, key: row.key.toLowerCase(), ...(typeof row.accountId === 'string' ? { accountId: row.accountId } : {}) })
      }
    }
    const countOutput = (chunk: Buffer | string) => {
      if (settled) return false
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (bytes > MAX_OUTPUT) { finish(failure('原版密钥组件输出超过限制，读取已停止')); return false }
      return !settled
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(failure('原版密钥组件无法启动，请检查文件权限与系统架构')))
    child.once('close', code => {
      if (signal.aborted) { abort(); return }
      // Accept a final JSON line without a newline only on a clean exit.
      if (!settled && code === 0 && buffered) consumeLine(buffered)
      if (!settled) finish(failure(code === 0 ? '原版密钥组件未返回有效结果' : '原版密钥组件异常退出，请检查组件版本与运行环境'))
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (!countOutput(chunk)) return
      // Process complete lines before retaining the bounded tail.
      let offset = 0, boundary: number
      while (!settled && (boundary = chunk.indexOf('\n', offset)) !== -1) {
        const fragment = chunk.slice(offset, boundary)
        if (Buffer.byteLength(buffered) + Buffer.byteLength(fragment) > MAX_LINE) { finish(failure('原版密钥组件单行输出超过限制，读取已停止')); return }
        const line = buffered + fragment
        buffered = ''; offset = boundary + 1
        consumeLine(line)
      }
      if (!settled) {
        const tail = chunk.slice(offset)
        if (Buffer.byteLength(buffered) + Buffer.byteLength(tail) > MAX_LINE) { finish(failure('原版密钥组件单行输出超过限制，读取已停止')); return }
        buffered += tail
      }
    })
    // Stderr can contain keys or paths. Count it against the total limit, but
    // never keep its bytes in a string, result, exception, or progress event.
    child.stderr?.on('data', countOutput)
    child.stdout?.on('error', () => finish(failure('原版密钥组件输出读取失败，请重试')))
    child.stderr?.on('error', () => finish(failure('原版密钥组件输出读取失败，请重试')))
    child.stdin?.on('error', () => finish(failure('无法向原版密钥组件发送请求，请检查组件协议')))
    timer = setTimeout(() => finish(failure('原版密钥组件读取超时，请保持微信登录后重试')), timeout)
    if (signal.aborted) { abort(); return }
    try { child.stdin?.end(`${JSON.stringify(payload)}\n`) }
    catch { finish(failure('无法向原版密钥组件发送请求，请检查组件协议')) }
  })
}
