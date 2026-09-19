import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'stardew-login'
export const inject = ['webServer', 'connection']
const ui = new URL('./ui/', import.meta.url)
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const files = {
  '/stardew-connect/style.css': ['login.css', 'text/css'],
  '/stardew-connect/app.js': ['login.js', 'text/javascript'],
  '/stardew-connect/enter.js': ['enter.js', 'text/javascript'],
  '/stardew-connect/liveness.css': ['liveness.css', 'text/css'],
  '/stardew-connect/liveness.js': ['liveness.js', 'text/javascript'],
}

// 只适配入口展示；链接校验、Cookie 签发和 API 鉴权仍由 dsh Connection 持有。
function authorize(connection, request) {
  const result = { allowed: false, status: 0, headers: {} }
  result.allowed = connection.authorizeIndex(request, {
    writeHead(status, value = {}) { result.status = status; result.headers = value }, end() {},
  })
  return result
}

export function tokenFromLink(value, origin) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请粘贴启动终端里的完整登录链接。')
  let link
  try { link = new URL(value.trim()) } catch { throw new Error('链接格式不正确，请复制包含 ?token= 的完整地址。') }
  if (link.origin !== origin || link.username || link.password || link.pathname !== '/' || link.hash) throw new Error('这不是当前 dsh 地址的登录链接，请使用当前服务的启动链接。')
  const tokens = link.searchParams.getAll('token')
  if (tokens.length !== 1 || !/^[A-Za-z0-9_-]{20,256}$/.test(tokens[0])) throw new Error('链接中缺少有效的登录凭据，请重新复制完整地址。')
  return tokens[0]
}

export async function apply(ctx, config) {
  const { webServer, connection } = ctx
  const port = webServer.port
  const origin = `http://127.0.0.1:${port}`
  const instanceId = randomUUID()
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const loginHtml = await readFile(new URL('login.html', ui), 'utf8')
  const send = (res, status, body, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(status, { ...headers, 'content-type': type, ...extra }); res.end(body)
  }
  const json = (res, status, value, extra) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra)
  const page = (res, status, state, head = false) => send(res, status, head ? undefined : loginHtml.replace('__LOGIN_STATE__', state), undefined, {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  })
  const route = async (req, res) => {
    if (!hosts.has(req.headers.host) || !localAddresses.has(req.socket.remoteAddress)) { send(res, 403, '连接页面仅供本机访问。', 'text/plain; charset=utf-8'); return }
    const requestOrigin = `http://${req.headers.host}`
    const url = new URL(req.url, requestOrigin)
    if (req.method === 'GET' && Object.hasOwn(files, url.pathname)) {
      const [file, type] = files[url.pathname]
      send(res, 200, await readFile(new URL(file, ui)), type); return
    }
    if (url.pathname === '/stardew-connect/instance' && ['GET', 'HEAD'].includes(req.method)) {
      json(res, 200, req.method === 'HEAD' ? undefined : { id: instanceId }); return
    }
    if (url.pathname === '/stardew-connect/login' && req.method === 'POST') {
      if (req.headers.origin !== requestOrigin || req.headers['content-type'] !== 'application/json') { json(res, 403, { error: '请从当前连接页面提交登录链接。' }); return }
      let body = ''; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 4096) { json(res, 413, { error: '链接过长，请只粘贴登录地址。' }); return }; body += chunk }
      let token
      try { token = tokenFromLink(JSON.parse(body)?.link, requestOrigin) }
      catch (error) { json(res, 400, { error: error instanceof SyntaxError ? '请求格式不正确，请重新提交。' : error.message }); return }
      const auth = authorize(connection, { method: 'GET', url: `/?token=${token}`, headers: req.headers })
      if (auth.status !== 303) { json(res, 401, { error: '登录链接无效或已过期。请在项目终端运行 pnpm open --print，复制新的链接后重试。' }); return }
      json(res, 200, { ok: true }, auth.headers['set-cookie'] ? { 'set-cookie': auth.headers['set-cookie'] } : {}); return
    }
    if (!['/', '/index.html'].includes(url.pathname)) { send(res, 404, '没有这个页面。', 'text/plain; charset=utf-8'); return }
    if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, undefined, undefined, { allow: 'GET, HEAD' }); return }
    const auth = authorize(connection, req)
    if (auth.allowed) {
      const html = webServer.renderIndex(await readFile(config.distIndex, 'utf8')).replace(/<head(?:\s[^>]*)?>/i, value => `${value}<base href="/"><link rel="stylesheet" href="/stardew-connect/liveness.css"><script src="/stardew-connect/liveness.js" data-instance="${instanceId}" defer></script>`)
      send(res, 200, req.method === 'HEAD' ? undefined : html); return
    }
    if (auth.status === 303) {
      // 先建立同源文档再进入首页，使无痕窗口从外部链接进入时也能携带 Strict Cookie。
      send(res, 200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>正在连接 dsh</title><script src="/stardew-connect/enter.js" defer></script><p>已登录，正在进入工作区… <a href="/">进入工作区</a></p></html>', undefined, {
        ...(auth.headers['set-cookie'] ? { 'set-cookie': auth.headers['set-cookie'] } : {}),
        'content-security-policy': "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      }); return
    }
    page(res, 401, url.searchParams.has('token') ? 'expired' : 'welcome', req.method === 'HEAD')
  }
  for (const path of ['/', '/index.html']) ctx.effect(() => webServer.register({ kind: 'exact', path, handler: route }), `stardew-login:${path}`)
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/stardew-connect', handler: route }), 'stardew-login:assets')
  // 登录链接只保存到本仓库忽略的私有运行目录，供 pnpm open 使用。
  const record = { id: instanceId, pid: process.pid, url: connection.authenticatedUrl(origin) }
  await mkdir(dirname(config.statePath), { recursive: true })
  const temporary = `${config.statePath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, config.statePath)
  ctx.effect(() => async () => {
    try { if (JSON.parse(await readFile(config.statePath, 'utf8')).id === record.id) await unlink(config.statePath) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }, 'stardew-login:record')
  console.log(`dsh 连接页：${origin}/；重新打开登录入口：pnpm open；复制到其他浏览器：pnpm open --print。`)
}
