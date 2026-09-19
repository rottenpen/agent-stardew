import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const DEFAULT_ENDPOINT = 'ws://127.0.0.1:17654/'
export const DEFAULT_TIMEOUT_MS = 15000
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const errorCodes = ['NOT_CONNECTED', 'INCOMPATIBLE_PROTOCOL', 'NO_SAVE_LOADED', 'STALE_REF', 'BUSY', 'PATH_BLOCKED', 'OUT_OF_REACH', 'INSUFFICIENT_RESOURCE', 'MENU_MISMATCH', 'TIMEOUT', 'CANCELLED', 'INVALID_ARGUMENT', 'DEPENDENCY_MISSING', 'UNSUPPORTED', 'INTERNAL_ERROR', 'OUTPUT_LIMIT'] as const
export const tileSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict()
const actionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const ref = z.string().regex(/^@s\d+:[em]\d+$/)
export const commandSchemas = {
  doctor: z.object({}).strict(),
  snapshot: z.object({ radius: z.number().int().min(1).max(16).optional() }).strict(),
  move: z.union([z.object({ tile: tileSchema }).strict(), z.object({ near: ref }).strict()]),
  select: z.object({ slot: z.number().int().min(0).max(35) }).strict(),
  use: z.object({ target: ref }).strict(),
  interact: z.object({ target: ref }).strict(),
  menu: z.object({ target: ref }).strict(),
  screenshot: z.object({}).strict(),
  status: z.object({}).strict(),
  stop: z.object({ actionId: actionIdSchema.optional() }).strict(),
} as const
export type Command = keyof typeof commandSchemas
export type Tile = z.infer<typeof tileSchema>
export const commands = Object.keys(commandSchemas) as Command[]
export const writes = new Set<Command>(['move', 'select', 'use', 'interact', 'menu'])

export const snapshotSchema = z.object({
  mode: z.enum(['game', 'mock']), kind: z.literal('snapshot'), snapshotId: z.string(), instanceId: z.string(), saveGeneration: z.number().int(),
  location: z.string(), date: z.object({ season: z.string(), day: z.number().int(), year: z.number().int() }).strict(),
  time: z.number().int(), player: z.object({ position: tileSchema, energy: z.number(), maxEnergy: z.number(), selectedSlot: z.number().int(), canMove: z.boolean() }).strict(),
  inventory: z.array(z.object({ slot: z.number().int(), itemId: z.string(), name: z.string(), count: z.number().int(), water: z.number().int().optional(), waterCapacity: z.number().int().optional(), tool: z.string().optional(), category: z.number().int().optional() }).strict()),
  observation: z.object({ radius: z.number().int(), center: tileSchema, truncated: z.boolean(), width: z.number().int(), height: z.number().int() }).strict(),
  entities: z.array(z.object({ ref, kind: z.string(), name: z.string(), tile: tileSchema, passable: z.boolean(), diggable: z.boolean().optional(), refillable: z.boolean().optional(), needsWater: z.boolean().optional(), tilled: z.boolean().optional(), watered: z.boolean().optional(), crop: z.string().optional(), action: z.string().optional() }).strict()),
  menu: z.object({ type: z.string(), text: z.string(), options: z.array(z.object({ ref, label: z.string() }).strict()) }).strict().nullable(),
}).strict()
export const helloSchema = z.object({
  mode: z.enum(['game', 'mock']), kind: z.literal('hello'), instanceId: z.string(), modVersion: z.string(), gameVersion: z.string(), smapiVersion: z.string(),
  saveLoaded: z.boolean(), singlePlayer: z.boolean(), capabilities: z.array(z.string()),
}).strict()
const actionSchema = z.object({
  kind: z.literal('action'), location: z.string(), position: tileSchema, changed: z.boolean(),
  detail: z.string(), snapshot: snapshotSchema.optional(),
}).strict()
const statusSchema = z.object({ kind: z.literal('status'), activeActionId: z.string().nullable(), command: z.string().nullable() }).strict()
const screenshotSchema = z.object({ kind: z.literal('screenshot'), mimeType: z.literal('image/png'), base64: z.string().optional(), path: z.string().optional() }).strict()
export const resultSchema = z.union([snapshotSchema, helloSchema, actionSchema, statusSchema, screenshotSchema])
const errorSchema = z.object({ code: z.enum(errorCodes), message: z.string(), retryable: z.boolean() }).strict()
const common = { protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string(), actionId: z.string().optional() }
export const responseSchema = z.discriminatedUnion('status', [
  z.object({ ...common, status: z.literal('completed'), result: resultSchema }).strict(),
  z.object({ ...common, status: z.literal('running'), result: statusSchema }).strict(),
  z.object({ ...common, status: z.literal('failed'), error: errorSchema, result: resultSchema.optional() }).strict(),
  z.object({ ...common, status: z.literal('cancelled'), error: errorSchema, result: resultSchema.optional() }).strict(),
])
export type Response = z.infer<typeof responseSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type ErrorCode = typeof errorCodes[number]
export interface Request {
  protocolVersion: 1; requestId: string; command: Command | 'hello'; args: Record<string, unknown>; timeoutMs: number; actionId?: string
}
export const requestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().min(1).max(80),
  command: z.enum([...commands, 'hello']), args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().min(100).max(120000), actionId: actionIdSchema.optional(),
}).strict().superRefine((r, ctx) => {
  const schema = r.command === 'hello' ? z.object({}).strict() : commandSchemas[r.command]
  if (!schema.safeParse(r.args).success) ctx.addIssue({ code: 'custom', message: '命令参数无效。', path: ['args'] })
  if (writes.has(r.command as Command) && !r.actionId) ctx.addIssue({ code: 'custom', message: '写动作需要 actionId。', path: ['actionId'] })
})
export class StardewError extends Error {
  constructor(public code: ErrorCode, message: string, public retryable = false) { super(message) }
}
export function failure(requestId: string, error: unknown, actionId?: string): Extract<Response, { status: 'failed' | 'cancelled' }> {
  const fault = error instanceof StardewError ? error : new StardewError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
  return { protocolVersion: 1, requestId, ...(actionId ? { actionId } : {}), status: fault.code === 'CANCELLED' ? 'cancelled' : 'failed', error: { code: fault.code, message: fault.message, retryable: fault.retryable } }
}
export function parseEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new StardewError('INVALID_ARGUMENT', 'endpoint 必须为本机 WebSocket URL。') }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new StardewError('INVALID_ARGUMENT', 'endpoint 仅支持 ws://127.0.0.1:<端口>/、localhost 或 [::1]。')
  }
  // 固定 localhost 的解析目标，避免本地 hosts 配置将其导向远端。
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url.href
}
export function exitCode(response: Response): number {
  if (response.status === 'completed' || response.status === 'running') return 0
  if (response.status === 'cancelled') return 130
  return response.error.code === 'INVALID_ARGUMENT' ? 2 : 1
}
export function render(response: Response): string {
  if (response.status === 'failed' || response.status === 'cancelled') return `${response.error.code}: ${response.error.message}`
  const value = response.result
  if (value.kind === 'snapshot') return renderSnapshot(value)
  if (value.kind === 'hello') return `[${value.mode}] Mod ${value.modVersion}  游戏 ${value.gameVersion}  SMAPI ${value.smapiVersion}\n存档=${value.saveLoaded ? '已加载' : '未加载'}  单人=${value.singlePlayer}\n能力: ${value.capabilities.join(', ')}`
  if (value.kind === 'action') return `${response.status}: ${value.detail}\nlocation=${value.location} player=(${value.position.x},${value.position.y})${value.snapshot ? '\n' + renderSnapshot(value.snapshot) : ''}`
  if (value.kind === 'screenshot') return value.path ?? '截图已生成'
  return value.activeActionId ? `running=${value.activeActionId} command=${value.command}` : '当前无活动动作'
}
export function renderSnapshot(s: Snapshot): string {
  const lines = [`[${s.mode}] snapshot=${s.snapshotId} location=${s.location} day=${s.date.season} ${s.date.day} Y${s.date.year} time=${s.time}`, `player=(${s.player.position.x},${s.player.position.y}) energy=${s.player.energy}/${s.player.maxEnergy} selectedSlot=${s.player.selectedSlot} canMove=${s.player.canMove}`, `观察半径=${s.observation.radius} 地图=${s.observation.width}x${s.observation.height} 截断=${s.observation.truncated}`]
  for (const e of s.entities) lines.push(`${e.ref} kind=${e.kind} ${e.name} (${e.tile.x},${e.tile.y})${e.tilled ? ' 已耕地' : ''}${e.crop ? ' crop=' + e.crop : ''}${e.watered === undefined ? '' : e.watered ? ' 已浇水' : ' 未浇水'}${e.needsWater ? ' 作物需要水' : ''}${e.refillable ? ' 可给水壶补水' : ''}${e.passable ? '' : ' 阻挡'}`)
  lines.push('inventory: ' + s.inventory.map(i => `slot=${i.slot} ${i.name} [${i.itemId}] x${i.count}${i.water === undefined ? '' : ' water=' + i.water}`).join('; '))
  if (s.menu) lines.push(`menu=${s.menu.type} ${s.menu.text}`, ...s.menu.options.map(o => `${o.ref} ${o.label}`))
  return lines.join('\n')
}
export const responseJsonSchema = z.toJSONSchema(responseSchema)
