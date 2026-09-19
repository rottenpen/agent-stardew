import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const dotnet = process.env.DOTNET_PATH ?? (existsSync('work/dotnet/dotnet') ? resolve('work/dotnet/dotnet') : 'dotnet')
const result = spawnSync(dotnet, ['run', '--project', 'tests/mod', '--configuration', 'Release'], { stdio: 'inherit', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } })
if (result.error) throw new Error(`需要 .NET 6 SDK（可用 DOTNET_PATH 指定）：${result.error.message}`)
process.exitCode = result.status ?? 1
