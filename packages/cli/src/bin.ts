#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { commandSchemas, commands, exitCode, failure, render, StardewError } from '@agent-stardew/protocol'
import type { Command, Response } from '@agent-stardew/protocol'
import { call } from './client.ts'

const HELP = `agent-stardew — 星露谷操作工具
  doctor [--game-path <游戏目录>]
  snapshot [--radius 1..16]
  move --tile <x> <y> | --near <引用>
  select --slot <0..35>
  use <引用> | interact <引用> | menu choose <引用>
  screenshot --output <文件.png>
  status | stop [--action-id <ID>]
通用：--json --endpoint <ws://127.0.0.1:17654/> --timeout <毫秒>
写动作：--action-id <ID>（同一存档会话内重复调用不重复执行）`

const abort = new AbortController()
process.on('SIGINT', () => abort.abort())
process.on('SIGTERM', () => abort.abort())
let json = process.argv.includes('--json')
let response: Response
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    endpoint: { type: 'string' }, timeout: { type: 'string' }, radius: { type: 'string' },
    tile: { type: 'string' }, near: { type: 'string' }, slot: { type: 'string' },
    output: { type: 'string' }, 'action-id': { type: 'string' }, 'game-path': { type: 'string' },
  } })
  json = values.json ?? false
  if (values.help) { console.log(HELP); process.exit(0) }
  const [name, ...rest] = positionals
  if (!commands.includes(name as Command)) throw new StardewError('INVALID_ARGUMENT', HELP)
  const command = name as Command
  const allowed: Record<Command, string[]> = { doctor: ['game-path'], snapshot: ['radius'], move: ['tile', 'near', 'action-id'], select: ['slot', 'action-id'], use: ['action-id'], interact: ['action-id'], menu: ['action-id'], screenshot: ['output'], status: [], stop: ['action-id'] }
  for (const key of Object.keys(values)) if (!['json', 'endpoint', 'timeout', 'help', ...allowed[command]].includes(key)) throw new StardewError('INVALID_ARGUMENT', `${command} 不支持 --${key}`)
  const args: Record<string, unknown> = {}
  if (command === 'snapshot' && values.radius !== undefined) args.radius = Number(values.radius)
  if (command === 'move') {
    if (values.tile !== undefined) args.tile = { x: Number(values.tile), y: Number(rest.shift()) }
    if (values.near !== undefined) args.near = values.near
  }
  if (command === 'select') args.slot = values.slot === undefined ? undefined : Number(values.slot)
  if (command === 'use' || command === 'interact') args.target = rest.shift()
  if (command === 'menu') {
    if (rest.shift() !== 'choose') throw new StardewError('INVALID_ARGUMENT', '用法：menu choose <引用>')
    args.target = rest.shift()
  }
  if (command === 'stop' && values['action-id']) args.actionId = values['action-id']
  if (rest.length) throw new StardewError('INVALID_ARGUMENT', `多余参数：${rest.join(' ')}`)
  if (command === 'screenshot' && !values.output) throw new StardewError('INVALID_ARGUMENT', 'screenshot 需要 --output <文件.png>')
  if (!commandSchemas[command].safeParse(args).success) throw new StardewError('INVALID_ARGUMENT', `参数无效。\n${HELP}`)

  response = await call(command, args, { endpoint: values.endpoint, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout), actionId: values['action-id'], signal: abort.signal })
  if (command === 'doctor' && response.status === 'failed' && response.error.code === 'NOT_CONNECTED') {
    const game = values['game-path'] ?? process.env.STARDEW_GAME_PATH ?? join(homedir(), 'Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS')
    for (const file of ['Stardew Valley.dll', 'StardewModdingAPI.dll', 'Mods/AgentStardew/manifest.json', 'Mods/AgentStardew/AgentStardew.dll']) {
      try { await access(join(game, file)) } catch { throw new StardewError('DEPENDENCY_MISSING', `缺少依赖：${join(game, file)}`) }
    }
  }
  if (response.status === 'completed' && response.result.kind === 'screenshot') {
    const path = resolve(values.output!)
    const data = Buffer.from(response.result.base64 ?? '', 'base64')
    if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new StardewError('INCOMPATIBLE_PROTOCOL', 'Mod 返回了无效 PNG。')
    await writeFile(path, data, { flag: 'wx' })
    response = { ...response, result: { kind: 'screenshot', mimeType: 'image/png', path } }
  }
} catch (error) {
  response = failure(randomUUID(), error instanceof StardewError ? error : new StardewError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)))
}
console.log(json ? JSON.stringify(response) : render(response))
process.exitCode = exitCode(response)
