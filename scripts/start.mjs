import { existsSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { parseArgs } from 'node:util'
import { root, loadState, gamePath, run } from './environment.mjs'

const { values } = parseArgs({ options: { mock: { type: 'boolean' }, jev: { type: 'boolean' }, 'game-path': { type: 'string' } } })
const flags = [...(values.mock ? ['--mock'] : []), ...(values.jev ? ['--jev'] : [])]
const state = await loadState()
const game = gamePath(values['game-path'] ?? state.gamePath)
const listening = await new Promise(resolve => {
  const socket = connect(values.mock ? 17655 : 17654, '127.0.0.1')
  const done = value => { socket.destroy(); resolve(value) }
  socket.setTimeout(400, () => done(false)); socket.once('error', () => done(false)); socket.once('connect', () => done(true))
})
if (values.mock && listening) throw new Error('模拟农场端口已占用，请关闭之前的 pnpm start / dev 后重试。')
if (listening && !state.setupAt) throw new Error('游戏正在运行。首次准备请先保存并退出游戏，再运行 pnpm start。')
if (!listening) await run(process.execPath, ['scripts/setup.mjs', ...flags, ...(values.mock ? [] : ['--game-path', game])])
if (!values.mock && !listening) {
  const executable = join(game, process.platform === 'win32' ? 'StardewModdingAPI.exe' : 'StardewModdingAPI')
  if (!existsSync(executable)) throw new Error(`未找到 SMAPI 启动程序：${executable}。请先安装 SMAPI。`)
  const log = openSync(join(root, 'work/game-launch.log'), 'a', 0o600)
  const child = spawn(executable, [], { cwd: game, detached: true, stdio: ['ignore', log, log] })
  try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref() }
  finally { closeSync(log) }
  console.log('游戏已启动，请选择单人测试存档；关闭 dsh 时游戏会保留，方便正常保存退出。')
  console.log('Agent Mod 支持失焦后台运行，可切换到 dsh 界面操作；后台游戏时间仍会推进。')
}
await run(process.execPath, ['scripts/dev.mjs', ...flags])
