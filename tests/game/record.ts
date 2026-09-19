import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { call } from '../../packages/cli/src/client.ts'
const response = await call('snapshot', {}, { endpoint: process.env.STARDEW_ENDPOINT, timeoutMs: 5000 })
if (response.status !== 'completed' || response.result.kind !== 'snapshot' || response.result.mode !== 'game') {
  console.error('实机观察未通过：需要已启动的 SMAPI 和已加载存档，模拟结果不能满足验收。', JSON.stringify(response)); process.exitCode = 1
} else {
  const directory = resolve('work/runs', `game-observation-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'snapshot.json'), JSON.stringify({ checkedAt: new Date().toISOString(), verification: 'real-game-observation-only', response }, null, 2))
  console.log(`真实游戏只读快照已保存：${directory}。这不代表农务任务或自主 Agent 已通过验收。`)
}
