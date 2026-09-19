import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { root } from './environment.mjs'

const { values } = parseArgs({ options: { print: { type: 'boolean' } } })
try {
  let record
  try { record = JSON.parse(await readFile(join(root, 'work/dsh-web.json'), 'utf8')) }
  catch { throw new Error('没有正在运行的 dsh。请先运行 pnpm dev --jev（游戏已启动时）或 pnpm start --jev。') }
  const url = new URL(record.url)
  if (url.origin !== `http://127.0.0.1:${url.port}` || url.pathname !== '/' || !/^[A-Za-z0-9_-]{20,256}$/.test(url.searchParams.get('token') ?? '') || [...url.searchParams.keys()].length !== 1 || url.username || url.password || url.hash) throw new Error('登录记录无效，请重新启动 dsh。')
  let response
  try { process.kill(record.pid, 0); response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }) }
  catch { throw new Error('dsh 服务已停止。请先启动服务，再运行 pnpm open。') }
  if (![200, 303].includes(response.status) || !response.headers.has('set-cookie')) throw new Error('登录链接已过期，请等待服务启动完成，或重新启动 dsh。')
  await response.body?.cancel()
  if (values.print) console.log(url.href)
  else {
    const [command, args] = process.platform === 'darwin' ? ['open', [url.href]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]] : ['xdg-open', [url.href]]
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'SystemRoot', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'ignore', env }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('打开浏览器失败'))) })
    console.log('已打开 dsh 登录入口。使用无痕或其他浏览器时，运行 pnpm open --print 获取链接。')
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
