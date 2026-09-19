import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { startMock } from '../support/mock-server.ts'
import { responseSchema } from '../../packages/protocol/src/index.ts'
async function cli(args: string[], onSpawn?: (child: ReturnType<typeof spawn>) => void) {
  const child = spawn(process.execPath, [resolve('packages/cli/dist/bin.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  let stdout = '', stderr = ''
  child.stdout!.on('data', data => stdout += data); child.stderr!.on('data', data => stderr += data)
  onSpawn?.(child)
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { code, stdout, stderr, response: responseSchema.parse(JSON.parse(stdout)) }
}
test('构建后的 CLI 输出单个 JSON，参数失败退出 2', async t => {
  const mock = await startMock(); t.after(mock.close)
  const result = await cli(['snapshot', '--json', '--endpoint', mock.endpoint, '--radius', '2'])
  assert.equal(result.code, 0); assert.equal(result.response.status, 'completed'); assert.equal(result.stdout.trim().split('\n').length, 1)
  for (const argv of [['move', '--tile', '2'], ['move', '--tile', '2', '3', '--near', '@s1:e1'], ['select', '--slot', 'oops'], ['snapshot', '--slot', '1']]) {
    const bad = await cli([...argv, '--json']); assert.equal(bad.code, 2); assert.equal(bad.response.status, 'failed')
  }
})
test('doctor 区分依赖未安装与 Mod 已连接但未加载存档', async t => {
  await mkdir('work/tests', { recursive: true }); const game = await mkdtemp(resolve('work/tests/doctor-'))
  const closed = await startMock(); await closed.close()
  const missing = await cli(['doctor', '--json', '--game-path', game, '--endpoint', closed.endpoint, '--timeout', '300'])
  if (missing.response.status === 'failed') assert.equal(missing.response.error.code, 'DEPENDENCY_MISSING'); else assert.fail('缺少依赖应失败')
  await mkdir(join(game, 'Mods/AgentStardew'), { recursive: true })
  for (const file of ['Stardew Valley.dll', 'StardewModdingAPI.dll', 'Mods/AgentStardew/manifest.json', 'Mods/AgentStardew/AgentStardew.dll']) await writeFile(join(game, file), '')
  const mock = await startMock({ saveLoaded: false }); t.after(mock.close)
  const result = await cli(['doctor', '--json', '--game-path', game, '--endpoint', mock.endpoint])
  if (result.response.status === 'failed') assert.equal(result.response.error.code, 'NO_SAVE_LOADED'); else assert.fail('存档尚未加载')
})
