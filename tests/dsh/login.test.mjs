import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Login from '../../scripts/dsh-login.mjs'

// 使用当前项目实际启动的 dsh，覆盖原生 Cookie 与路由的接入边界。
const require = createRequire(new URL('../../work/dsh/profiles/stardew-dev/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Credentials } = await load('@deepseek-ai/dsh-credentials-local')
const { default: WebServer } = await load('@deepseek-ai/dsh-host-webserver')
const Connection = await load('@deepseek-ai/dsh-client-connection')
const Frontend = await load('@deepseek-ai/dsh-host-frontend-static')

async function fixture(t) {
  await mkdir('work/tests', { recursive: true })
  const dir = resolve(await mkdtemp('work/tests/login-'))
  const distIndex = join(dir, 'index.html'); const statePath = join(dir, 'dsh-web.json')
  await writeFile(distIndex, '<html><head></head><body>已进入工作区</body></html>')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Credentials, { path: join(dir, 'credentials.yml'), watch: false })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection)
  await ctx.plugin(Frontend, { distIndex })
  const login = await ctx.plugin(Login, { distIndex, statePath })
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const url = ctx.connection.authenticatedUrl(origin)
  const get = (path = '/', options = {}) => fetch(origin + path, { redirect: 'manual', ...options })
  const submit = (link, extra = {}) => get('/stardew-connect/login', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ link }) })
  return { ctx, origin, url, get, submit, login, statePath }
}

test('匿名入口可操作，原生 API 仍需登录；无效、跨站和过大请求均拒绝', async t => {
  const { get, submit, origin, url } = await fixture(t)
  for (const path of ['/', '/index.html']) {
    const page = await get(path)
    assert.equal(page.status, 401)
    assert.match(page.headers.get('content-type'), /text\/html/)
    const body = await page.text()
    assert.match(body, /连接你的工作区/); assert.match(body, /pnpm open --print/)
    assert.ok(!body.includes(new URL(url).searchParams.get('token')))
  }
  assert.equal((await get('/api')).status, 401)
  assert.equal((await get('/', { method: 'HEAD' })).status, 401)
  assert.equal(await (await get('/', { method: 'HEAD' })).text(), '')
  assert.equal((await get('/', { method: 'POST' })).status, 405)
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = request(origin, { headers: { host: 'malicious.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.once('error', reject); req.end()
  })
  assert.equal(rejectedHost, 403)
  assert.equal((await submit('https://example.com/?token=' + 'a'.repeat(43))).status, 400)
  assert.equal((await submit(url, { origin: 'https://example.com' })).status, 403)
  const expired = await submit(origin + '/?token=' + 'a'.repeat(43))
  assert.equal(expired.status, 401); assert.match((await expired.json()).error, /无效或已过期/)
  assert.equal((await submit('x'.repeat(5000))).status, 413)
})

test('粘贴链接复用原生 Cookie，登录后原地址加载工作区及原生索引注入', async t => {
  const { ctx, submit, url, get, statePath } = await fixture(t)
  ctx.webServer.tapIndex(html => html.replace('</head>', '<meta name="fixture" content="host"></head>'))
  const response = await submit(url)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const header = response.headers.get('set-cookie')
  assert.match(header, /HttpOnly; SameSite=Strict/)
  const cookie = header.split(';')[0]
  for (const path of ['/', '/index.html']) {
    const page = await get(path, { headers: { cookie } })
    assert.equal(page.status, 200)
    const html = await page.text(); assert.match(html, /已进入工作区/); assert.match(html, /<base href="\/">/); assert.match(html, /name="fixture"/)
    assert.match(html, /stardew-connect\/liveness\.js/)
    assert.match(html, /data-instance="[0-9a-f-]{36}"/)
  }
  assert.notEqual((await get('/api', { headers: { cookie } })).status, 401)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.url, url)
  const instance = await get('/stardew-connect/instance')
  assert.equal(instance.status, 200)
  assert.deepEqual(await instance.json(), { id: state.id })
  assert.match(await (await get('/stardew-connect/liveness.js')).text(), /location\.replace\('\/'\)/)
  if (process.platform !== 'win32') assert.equal((await stat(statePath)).mode & 0o777, 0o600)
})

test('直接启动链接先建立同源页面，过期链接给出可恢复提示；卸载恢复宿主入口', async t => {
  const { get, url, login, statePath } = await fixture(t)
  const exchange = await get(new URL(url).search)
  assert.equal(exchange.status, 200)
  assert.ok(exchange.headers.has('set-cookie'))
  const html = await exchange.text()
  assert.match(html, /stardew-connect\/enter.js/)
  assert.ok(!html.includes(new URL(url).searchParams.get('token')))
  const expired = await get('/?token=expired')
  assert.equal(expired.status, 401); assert.match(await expired.text(), /data-state="expired"/)
  await login.dispose()
  assert.equal((await get('/')).headers.get('content-type'), 'text/plain; charset=utf-8')
  await assert.rejects(readFile(statePath), { code: 'ENOENT' })
})
