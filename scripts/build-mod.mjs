import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const game = process.env.STARDEW_GAME_PATH ?? `${homedir()}/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS`
const dotnet = process.env.DOTNET_PATH ?? (existsSync('work/dotnet/dotnet') ? resolve('work/dotnet/dotnet') : 'dotnet')
if (!existsSync(`${game}/StardewModdingAPI.dll`)) throw new Error('缺少游戏或 SMAPI；请设置 STARDEW_GAME_PATH。')
const result = spawnSync(dotnet, ['build', 'mods/AgentStardew', '-c', 'Release', `-p:GamePath=${game}`], {
  stdio: 'inherit', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
})
if (result.error) throw new Error(`无法启动 .NET SDK，请设置 DOTNET_PATH：${result.error.message}`)
process.exitCode = result.status ?? 1
