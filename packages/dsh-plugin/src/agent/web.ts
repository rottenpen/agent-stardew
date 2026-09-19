import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { validateInput, type JevRunner, type RunInput } from './runner.js'
import type { StagePlanner } from './planner.js'

interface WebHost {
  host: string; port: number
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}
export function mountPanel(ctx: Context, runner: JevRunner, planner: StagePlanner) {
  ctx.inject(['webServer'], scoped => {
    const server = scoped.get('webServer') as WebHost
    const token = randomBytes(24).toString('hex')
    const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8').replace('__STARDew_TOKEN__', token)
    const files: Record<string, string> = {
      'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8',
      'assets/welcome-farm-day-v1.png': 'image/png', 'assets/agent-farmer-idle-v1.png': 'image/png', 'assets/app-icon-chicken-whale-v1.png': 'image/png',
    }
    const send = (res: ServerResponse, status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(data))
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: '/stardew', async handler(req, res) {
      const host = req.headers.host ?? ''
      const allowedHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]
      const remote = req.socket?.remoteAddress
      if (!allowedHosts.includes(host) || (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))) { send(res, 403, { error: '运行面板仅供本机访问。' }); return }
      const path = new URL(req.url ?? '/', `http://${host}`).pathname
      if (req.method === 'GET' && (path === '/stardew' || path === '/stardew/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" })
        res.end(html); return
      }
      const file = path.slice('/stardew/'.length)
      if (req.method === 'GET' && Object.hasOwn(files, file)) {
        const content = readFileSync(new URL(`../ui/${file}`, import.meta.url))
        res.writeHead(200, { 'content-type': files[file], 'cache-control': file.startsWith('assets/') ? 'public, max-age=86400' : 'no-cache', 'x-content-type-options': 'nosniff' })
        res.end(content); return
      }
      if (req.headers['x-stardew-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${host}`)) { send(res, 403, { error: '页面已过期，请刷新后再操作。' }); return }
      if (req.method === 'GET' && path === '/stardew/api/state') { send(res, 200, planner.view()); return }
      if (req.method !== 'POST' || !['/stardew/api/start', '/stardew/api/resume', '/stardew/api/pause', '/stardew/api/stop', '/stardew/api/observe'].includes(path)) { send(res, 404, { error: '没有这个操作。' }); return }
      try {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 16384) { send(res, 413, { error: '请求过大。' }); return }
          chunks.push(Buffer.from(chunk))
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求需要为对象。')
        if (path.endsWith('/start')) {
          const input = validateInput(body as RunInput)
          if (runner.busy) throw new Error('已有操作正在执行，请先暂停或停止。')
          planner.manual(); runner.start(input)
        }
        else if (path.endsWith('/resume')) {
          if ((body.singleStep !== undefined && typeof body.singleStep !== 'boolean') || (body.goal !== undefined && typeof body.goal !== 'string')) throw new Error('继续参数无效。')
          runner.resume(body.singleStep ?? false, body.goal)
          planner.manual()
        } else if (path.endsWith('/pause')) { planner.manual('paused'); await runner.halt('paused') }
        else if (path.endsWith('/stop')) { planner.manual(); await runner.halt('stopped') }
        else await runner.observe()
        send(res, 200, planner.view())
      } catch (error) { send(res, 409, { error: error instanceof Error ? error.message : '操作失败。' }) }
    } }), 'stardew:panel')
  })
}
