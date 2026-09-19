import { existsSync, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { connect } from 'node:net'
import { root, statePath, loadState, saveState, dsh, dshHome, dshEnv, profile, gamePath, run, writeRuntimePatch } from './environment.mjs'

const { values } = parseArgs({ options: { mock: { type: 'boolean' }, jev: { type: 'boolean' }, 'game-path': { type: 'string' } } })
const state = await loadState()
await run(process.execPath, ['scripts/build.mjs'])
const game = gamePath(values['game-path'] ?? state.gamePath)
if (!values.mock) {
  if (!existsSync(join(game, 'StardewModdingAPI.dll'))) throw new Error(`没有找到游戏或 SMAPI：${game}。安装 SMAPI 后重试，或使用 pnpm run setup --mock。`)
  const connected = await new Promise(resolve => { const socket = connect(17654, '127.0.0.1'); const done = value => { socket.destroy(); resolve(value) }; socket.setTimeout(300, () => done(false)); socket.once('error', () => done(false)); socket.once('connect', () => done(true)) })
  if (connected) throw new Error('Mod 正在运行。请先保存并关闭游戏，再安装新版本。')
  await run(process.execPath, ['scripts/build-mod.mjs'], { env: { ...process.env, STARDEW_GAME_PATH: game } })
  const target = join(game, 'Mods/AgentStardew')
  if (existsSync(target)) {
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    if (manifest.UniqueID !== 'AgentStardew.Bridge') throw new Error(`目标目录属于其他 Mod：${target}`)
    await cp(target, join(root, `work/backups/mod-${Date.now()}`), { recursive: true, errorOnExist: true, force: false })
  }
  await mkdir(target, { recursive: true })
  for (const name of ['AgentStardew.dll', 'manifest.json']) {
    const temporary = join(target, `${name}.tmp`)
    await cp(join(root, 'mods/AgentStardew/bin/Release/net6.0', name), temporary)
    await rename(temporary, join(target, name))
  }
  state.gamePath = game
  console.log(`已安装 Mod：${target}`)
}
await mkdir(join(root, 'work'), { recursive: true })
const profilePath = join(dshHome, 'profiles', profile)
if (!existsSync(join(profilePath, 'package.json'))) {
  const log = createWriteStream(join(root, 'work/dsh-profile-init.log'))
  await new Promise(resolve => log.once('open', resolve))
  try { await run(dsh, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv(), stdio: ['ignore', log.fd, 'inherit'] }) }
  finally { log.end() }
}
await run(dsh, ['plugin', '--profile', profile, 'add', join(root, 'packages/dsh-plugin')], { env: dshEnv() })
const patch = join(root, 'work/stardew.patch.yml')
const jevEnabled = values.jev ?? state.jevEnabled ?? false
await writeRuntimePatch({ patch }, { mock: values.mock, jev: jevEnabled })
await saveState({ ...state, profile, dshHome, patch, jevEnabled, mode: values.mock ? 'mock' : 'game', setupAt: new Date().toISOString() })
console.log(`开发环境已准备（${values.mock ? 'mock' : 'game'}）。配置：${statePath}`)
console.log(`运行 ${values.mock ? 'pnpm dev --mock' : 'pnpm dev'} 打开独立 dsh Web UI；Jev 运行面板位于 /stardew，使用 OPENROUTER_API_KEY。`)
