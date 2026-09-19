import { mkdir, writeFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { root, run } from './environment.mjs'
const out = join(root, 'work/release')
await mkdir(out, { recursive: true })
await run(process.execPath, ['scripts/build.mjs'])
for (const name of ['protocol', 'cli', 'dsh-plugin']) await run('pnpm', ['pack', '--pack-destination', out], { cwd: join(root, 'packages', name) })
if (existsSync(join(root, 'mods/AgentStardew/bin/Release/net6.0/AgentStardew.dll'))) {
  await run(process.execPath, ['scripts/build-mod.mjs'])
  const staging = join(out, 'mod/AgentStardew'); await mkdir(staging, { recursive: true })
  for (const file of ['AgentStardew.dll', 'manifest.json']) await cp(join(root, 'mods/AgentStardew/bin/Release/net6.0', file), join(staging, file))
  console.log(`Mod 已收集：${staging}`)
} else console.log('本次产物仅包含 JavaScript 包；构建 Mod 后可收集游戏产物。')
const compatibility = { protocolVersion: 1, dsh: '0.1.5-rc.1', smapi: '4.5.2', modFramework: 'net6.0', createdAt: new Date().toISOString() }
await writeFile(join(out, 'compatibility.json'), JSON.stringify(compatibility, null, 2) + '\n')
console.log(`发行预览产物：${out}`)
