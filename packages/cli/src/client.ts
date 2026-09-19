import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, StardewError, commandSchemas, failure, parseEndpoint, responseSchema, writes } from '@agent-stardew/protocol'
import type { Command, Request, Response } from '@agent-stardew/protocol'

export interface ClientOptions { endpoint?: string; timeoutMs?: number; signal?: AbortSignal; actionId?: string }
export async function call(command: Command, args: unknown, options: ClientOptions = {}): Promise<Response> {
  const requestId = randomUUID()
  const actionId = writes.has(command) ? options.actionId ?? randomUUID() : undefined
  try {
    const parsed = commandSchemas[command].safeParse(args)
    if (!parsed.success) throw new StardewError('INVALID_ARGUMENT', parsed.error.message)
    const endpoint = parseEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new StardewError('INVALID_ARGUMENT', 'timeout 必须为 100–120000 毫秒。')
    if (actionId && !/^[a-zA-Z0-9_-]{1,80}$/.test(actionId)) throw new StardewError('INVALID_ARGUMENT', 'action-id 仅支持 1–80 位字母、数字、下划线和连字符。')
    if (options.signal?.aborted) throw new StardewError('CANCELLED', '调用已取消。')
    return await new Promise<Response>((resolve) => {
      const ws = new WebSocket(endpoint, { maxPayload: MAX_RESPONSE_BYTES, handshakeTimeout: Math.min(timeoutMs, 5000), perMessageDeflate: false })
      const helloId = randomUUID()
      let phase: 'hello' | 'action' = 'hello'
      let settled = false
      let abortError: StardewError | undefined
      let abortTimer: NodeJS.Timeout | undefined
      const finish = (response: Response) => {
        if (settled) return
        settled = true
        clearTimeout(timer); clearTimeout(abortTimer)
        options.signal?.removeEventListener('abort', onAbort)
        // close 会等待对端握手，terminate 保证一次 CLI 调用不会遗留连接。
        ws.terminate()
        resolve(response)
      }
      const send = (request: Request) => ws.send(JSON.stringify(request))
      const abort = (error: StardewError) => {
        if (settled || abortError) return
        abortError = error
        if (phase === 'action' && actionId && ws.readyState === WebSocket.OPEN) {
          send({ protocolVersion: 1, requestId: randomUUID(), command: 'stop', args: { actionId }, timeoutMs: 1000 })
          abortTimer = setTimeout(() => finish(failure(requestId, error, actionId)), 1000)
        } else finish(failure(requestId, error, actionId))
      }
      const timer = setTimeout(() => abort(new StardewError('TIMEOUT', phase === 'hello' ? 'Mod 未完成握手，请检查游戏窗口是否正常刷新。' : actionId ? '等待游戏结果超时；已请求停止动作，请重新观察。' : '游戏未返回结果，请检查窗口与存档状态。', true)), timeoutMs)
      const onAbort = () => abort(new StardewError('CANCELLED', '调用已取消；已请求停止动作。'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      ws.on('error', error => finish(failure(requestId, abortError ?? new StardewError('NOT_CONNECTED', `无法连接 Mod：${error.message}`, true), actionId)))
      ws.on('close', () => finish(failure(requestId, abortError ?? new StardewError('NOT_CONNECTED', 'Mod 连接已断开；动作结果未知，请重新观察。', true), actionId)))
      ws.on('open', () => send({ protocolVersion: 1, requestId: helloId, command: 'hello', args: {}, timeoutMs }))
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw.toString()) as Record<string, unknown>
          if (data.protocolVersion !== 1) throw new StardewError('INCOMPATIBLE_PROTOCOL', 'Mod 协议版本不兼容。')
          const response = responseSchema.parse(data)
          if (phase === 'hello') {
            if (response.requestId !== helloId) return
            if (response.status === 'failed' || response.status === 'cancelled') { finish({ ...response, requestId }); return }
            if (response.status !== 'completed' || response.result.kind !== 'hello') throw new StardewError('INCOMPATIBLE_PROTOCOL', 'hello 必须返回连接信息。')
            if (!response.result.singlePlayer) throw new StardewError('UNSUPPORTED', '当前仅支持单人存档。')
            if (!response.result.saveLoaded && command !== 'status' && command !== 'stop') {
              finish({ ...failure(requestId, new StardewError('NO_SAVE_LOADED', 'Mod 已连接，请先加载单人存档。', true)), result: response.result }); return
            }
            if (command === 'doctor') { finish({ ...response, requestId }); return }
            if (!response.result.capabilities.includes(command)) throw new StardewError('UNSUPPORTED', `当前 Mod 不支持 ${command}。`)
            phase = 'action'
            send({ protocolVersion: 1, requestId, command, args: parsed.data, timeoutMs, ...(actionId ? { actionId } : {}) })
          } else if (response.requestId === requestId && response.status !== 'running') {
            if (response.status === 'completed') {
              const expected = writes.has(command) ? 'action' : command === 'stop' ? 'status' : command
              if (response.result.kind !== expected) throw new StardewError('INCOMPATIBLE_PROTOCOL', 'Mod 返回的结果类型与命令不匹配。')
            }
            if (actionId && response.actionId !== actionId) throw new StardewError('INCOMPATIBLE_PROTOCOL', 'Mod 返回的 actionId 不匹配。')
            finish(abortError ? { ...failure(requestId, abortError, actionId), ...(response.result ? { result: response.result } : {}) } : response)
          } else if (response.requestId === requestId && command === 'status') finish(response)
        } catch (error) {
          finish(failure(requestId, error instanceof StardewError ? error : new StardewError('INCOMPATIBLE_PROTOCOL', 'Mod 返回了无效的 JSON 或结果 schema。'), actionId))
        }
      })
    })
  } catch (error) { return failure(requestId, error, actionId) }
}
