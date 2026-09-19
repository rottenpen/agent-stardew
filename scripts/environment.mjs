import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))
export const statePath = join(root, 'work/dev.json')
export const dshHome = join(root, 'work/dsh')
export const dsh = process.env.DSH_PATH || 'dsh'
export const profile = 'stardew-dev'
export function gamePath(explicit = process.env.STARDEW_GAME_PATH) {
  if (explicit) return resolve(explicit)
  const candidates = process.platform === 'darwin'
    ? [join(homedir(), 'Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS')]
    : process.platform === 'win32'
      ? [join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Steam/steamapps/common/Stardew Valley')]
      : [join(homedir(), '.local/share/Steam/steamapps/common/Stardew Valley'), join(homedir(), '.steam/steam/steamapps/common/Stardew Valley')]
  return candidates.find(p => existsSync(join(p, 'Stardew Valley.dll'))) ?? candidates[0]
}
export async function loadState() { try { return JSON.parse(await readFile(statePath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; return {} } }
export async function saveState(state) { await mkdir(dirname(statePath), { recursive: true }); const temporary = `${statePath}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await rename(temporary, statePath) }
export function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: 'inherit', ...options })
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} 退出：${signal ?? code}`)))
  })
}
export const dshEnv = () => ({ ...process.env, DSH_HOME: dshHome })

export async function writeRuntimePatch(state, { mock = false, jev = state.jevEnabled ?? false } = {}) {
  const profileRequire = createRequire(join(dshHome, 'profiles', profile, 'package.json'))
  const webRequire = createRequire(profileRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const distIndex = join(dirname(webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html')
  await writeFile(state.patch, `- id: stardew\n  config:\n    endpoint: ${JSON.stringify(mock ? 'ws://127.0.0.1:17655/' : 'ws://127.0.0.1:17654/')}\n    timeoutMs: 120000\n    jevEnabled: ${!!jev}\n- insert:\n    - id: stardew-workspace\n      name: ${JSON.stringify(join(root, 'scripts/dsh-workspace.mjs'))}\n      config:\n        path: ${JSON.stringify(root)}\n    - id: stardew-login\n      name: ${JSON.stringify(join(root, 'scripts/dsh-login.mjs'))}\n      config:\n        distIndex: ${JSON.stringify(distIndex)}\n        statePath: ${JSON.stringify(join(root, 'work/dsh-web.json'))}\n`)
}
