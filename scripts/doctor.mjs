import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { root, gamePath, dsh, loadState } from './environment.mjs'
const { values } = parseArgs({ options: { mock: { type: 'boolean' }, json: { type: 'boolean' } } })
const state = await loadState()
const checks = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.versions.node }]
const dshVersion = spawnSync(dsh, ['--version'], { encoding: 'utf8', timeout: 10000 })
checks.push({ name: 'dsh', ok: dshVersion.status === 0, detail: dshVersion.status === 0 ? dshVersion.stdout.trim() : '请安装 dsh，或设置 DSH_PATH。' })
checks.push({ name: 'TypeScript 构建', ok: existsSync(join(root, 'packages/cli/dist/bin.js')), detail: 'pnpm build:ts' })
if (!values.mock) for (const file of ['Stardew Valley.dll', 'StardewModdingAPI.dll', 'Mods/AgentStardew/AgentStardew.dll']) {
  const path = join(gamePath(state.gamePath), file); checks.push({ name: file, ok: existsSync(path), detail: path })
}
if (checks.find(c => c.name === 'TypeScript 构建')?.ok) {
  const endpoint = values.mock ? 'ws://127.0.0.1:17655/' : 'ws://127.0.0.1:17654/'
  const child = spawnSync(process.execPath, [join(root, 'packages/cli/dist/bin.js'), 'snapshot', '--json', '--endpoint', endpoint, '--timeout', '2000'], { encoding: 'utf8', timeout: 5000 })
  try {
    const r = JSON.parse(child.stdout); checks.push({ name: '游戏连接', ok: r.status === 'completed', detail: r.status === 'completed' ? `[${r.result.mode}] ${r.result.location}` : `${r.error.code}: ${r.error.message}（${endpoint}）` })
  } catch { checks.push({ name: '游戏连接', ok: false, detail: child.error?.message ?? child.stderr }) }
}
console.log(values.json ? JSON.stringify({ mode: values.mock ? 'mock' : 'game', checks }) : checks.map(c => `${c.ok ? '通过' : '未就绪'} · ${c.name}：${c.detail}`).join('\n'))
process.exitCode = checks.every(c => c.ok) ? 0 : 1
