import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { commandSchemas, failure, requestSchema, StardewError, writes } from '../../packages/protocol/src/index.ts'
import type { Command, Request, Response, Snapshot } from '../../packages/protocol/src/index.ts'

export interface MockOptions { delayMs?: number; saveLoaded?: boolean; protocolVersion?: number; singlePlayer?: boolean; water?: number }
export async function startMock(options: MockOptions & { port?: number } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0, maxPayload: 65536 })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const instanceId = `mock-${randomUUID()}`
  const refs = new Map<string, { kind: string; x: number; y: number; location: string; menu?: string }>()
  const seen = new Map<string, { signature: string; response?: Response }>()
  const tiles = new Map<string, { tilled?: boolean; watered?: boolean; crop?: string }>()
  const events: Request[] = []
  let seq = 0, x = 2, y = 2, day = 1, selectedSlot = 0, seeds = 5, water = options.water ?? 20, location = 'Farm'
  let menu: string | undefined
  let active: { request: Request; socket: WebSocket; timer: NodeJS.Timeout; timeout: NodeJS.Timeout } | undefined
  const hello = { mode: 'mock' as const, kind: 'hello' as const, instanceId, modVersion: '0.1.0', gameVersion: 'mock', smapiVersion: 'mock', saveLoaded: options.saveLoaded ?? true, singlePlayer: options.singlePlayer ?? true, capabilities: Object.keys(commandSchemas).filter(n => n !== 'doctor') }
  const status = () => ({ kind: 'status' as const, activeActionId: active?.request.actionId ?? null, command: active?.request.command ?? null })
  function snapshot(radius = 8): Snapshot {
    const snapshotId = `s${++seq}`
    const entities: Snapshot['entities'] = []
    const add = (kind: string, name: string, tx: number, ty: number, passable: boolean) => {
      const ref = `@${snapshotId}:e${entities.length + 1}`
      refs.set(ref, { kind, x: tx, y: ty, location })
      const dirt = tiles.get(`${location}:${tx}:${ty}`)
      entities.push({ ref, kind, name, tile: { x: tx, y: ty }, passable, diggable: kind === 'tile' && location === 'Farm' && passable && !dirt?.tilled, refillable: kind === 'water', needsWater: !!dirt?.crop && !dirt.watered, ...dirt })
    }
    for (let ty = Math.max(0, y - radius); ty <= Math.min(11, y + radius); ty++)
      for (let tx = Math.max(0, x - radius); tx <= Math.min(11, x + radius); tx++) {
        const source = location === 'Farm' && tx === 6 && ty === 2
        add(source ? 'water' : 'tile', source ? '水源' : '可耕地', tx, ty, !source && !(tx === 5 && ty === 5))
      }
    add(location === 'Farm' ? 'door' : 'bed', location === 'Farm' ? '农舍入口' : '床', 1, 1, false)
    const menuOptions: { ref: string; label: string }[] = []
    if (menu) for (const [i, label] of ['是', '否'].entries()) {
      const ref = `@${snapshotId}:m${i + 1}`; refs.set(ref, { kind: 'menu', x, y, location, menu }); menuOptions.push({ ref, label })
    }
    // 快照数量有界，与实机引用缓存的生命周期一致。
    for (const key of refs.keys()) if (Number(/^@s(\d+):/.exec(key)?.[1]) <= seq - 16) refs.delete(key)
    return { mode: 'mock', kind: 'snapshot', snapshotId, instanceId, saveGeneration: 1, location,
      date: { season: 'spring', day, year: 1 }, time: 600, player: { position: { x, y }, energy: 270, maxEnergy: 270, selectedSlot, canMove: !menu },
      inventory: [{ slot: 0, itemId: '(T)Hoe', name: '锄头', count: 1, tool: 'Hoe' }, { slot: 1, itemId: '(T)WateringCan', name: '浇水壶', count: 1, water, waterCapacity: 20, tool: 'WateringCan' }, ...(seeds ? [{ slot: 2, itemId: '(O)472', name: '防风草种子', count: seeds, category: -74 }] : [])],
      observation: { radius, center: { x, y }, truncated: radius < 11, width: 12, height: 12 }, entities, menu: menu ? { type: 'DialogueBox', text: '睡觉吗？', options: menuOptions } : null }
  }
  const send = (socket: WebSocket, response: Response) => { if (socket.readyState === 1) socket.send(JSON.stringify({ ...response, protocolVersion: options.protocolVersion ?? 1 })) }
  const ok = (r: Request, result: Extract<Response, { status: 'completed' }>['result']): Response => ({ protocolVersion: 1, requestId: r.requestId, status: 'completed', ...(r.actionId ? { actionId: r.actionId } : {}), result })
  const fail = (r: Request, error: unknown) => failure(r.requestId, error, r.actionId)
  const fault = (code: ConstructorParameters<typeof StardewError>[0], message: string): never => { throw new StardewError(code, message) }
  const finish = (response: Response) => {
    if (!active) return
    const prior = active; clearTimeout(prior.timer); clearTimeout(prior.timeout); active = undefined
    const record = seen.get(prior.request.actionId!)!; record.response = response; send(prior.socket, response)
  }
  function execute(r: Request): Response {
    const args = r.args
    const reference = (args.near ?? args.target) as string | undefined
    const target = reference ? refs.get(reference) : undefined
    if (reference && (!target || target.location !== location)) fault('STALE_REF', '引用已过期。')
    if (r.command === 'move') {
      const tile = args.tile as { x: number; y: number } | undefined
      const to = tile ?? { x: target!.x + 1, y: target!.y }
      if (to.x > 11 || to.y > 11 || (to.x === 5 && to.y === 5)) fault('PATH_BLOCKED', '路径阻挡。')
      x = to.x; y = to.y
    } else if (r.command === 'select') selectedSlot = args.slot as number
    else if (r.command === 'use') {
      if (Math.abs(x - target!.x) + Math.abs(y - target!.y) > 1) fault('OUT_OF_REACH', '目标太远。')
      const key = `${location}:${target!.x}:${target!.y}`; const tile = tiles.get(key) ?? {}
      if (selectedSlot === 0) { if (tile.tilled || target!.kind === 'water') fault('INVALID_ARGUMENT', '需要空置可耕地。'); tile.tilled = true }
      else if (selectedSlot === 2) { if (!seeds) fault('INSUFFICIENT_RESOURCE', '种子不足。'); if (!tile.tilled || tile.crop) fault('INVALID_ARGUMENT', '需要空耕地。'); tile.crop = '24'; seeds-- }
      else if (selectedSlot === 1) {
        if (target!.kind === 'water') { if (water >= 20) fault('INVALID_ARGUMENT', '浇水壶已满。'); water = 20 }
        else { if (!water) fault('INSUFFICIENT_RESOURCE', '水不足。'); if (!tile.tilled || tile.watered) fault('INVALID_ARGUMENT', '需要未浇水耕地。'); tile.watered = true; water-- }
      }
      else fault('UNSUPPORTED', '请选择农具。')
      tiles.set(key, tile)
    } else if (r.command === 'interact') {
      if (Math.abs(x - target!.x) + Math.abs(y - target!.y) > 1) fault('OUT_OF_REACH', '目标太远。')
      if (target!.kind === 'door') { location = 'FarmHouse'; x = 2; y = 1 }
      else if (target!.kind === 'bed') menu = randomUUID()
      else fault('UNSUPPORTED', '目标没有交互。')
    } else if (r.command === 'menu') {
      if (target!.kind !== 'menu' || !menu || target!.menu !== menu) fault('MENU_MISMATCH', '菜单已改变。')
      if (reference!.endsWith(':m1')) { day++; for (const tile of tiles.values()) tile.watered = false }
      menu = undefined
    }
    return ok(r, { kind: 'action', location, position: { x, y }, changed: true, detail: `[mock] ${r.command} 完成`, snapshot: snapshot() })
  }
  server.on('connection', socket => {
    let handshaken = false
    socket.on('message', bytes => {
      let raw: Record<string, unknown>
      try { raw = JSON.parse(bytes.toString()) } catch { socket.close(); return }
      const parsed = requestSchema.safeParse(raw)
      if (!parsed.success) { send(socket, failure(String(raw.requestId ?? ''), new StardewError('INVALID_ARGUMENT', parsed.error.message))); return }
      const r = parsed.data as Request; events.push(r)
      try {
        if (r.command === 'hello') { handshaken = true; send(socket, ok(r, hello)); return }
        if (!handshaken) fault('INCOMPATIBLE_PROTOCOL', '需要 hello。')
        if (r.command === 'status') { send(socket, ok(r, status())); return }
        if (r.command === 'stop') {
          if (active && (!r.args.actionId || active.request.actionId === r.args.actionId)) finish(fail(active.request, new StardewError('CANCELLED', '已停止。')))
          send(socket, ok(r, status())); return
        }
        if (!hello.saveLoaded) fault('NO_SAVE_LOADED', '需要加载存档。')
        if (r.command === 'snapshot') { send(socket, ok(r, snapshot(r.args.radius as number | undefined))); return }
        if (!writes.has(r.command as Command)) fault('UNSUPPORTED', '模拟模式不提供此操作。')
        const signature = JSON.stringify([r.command, r.args]); const record = seen.get(r.actionId!)
        if (record) {
          if (record.signature !== signature) fault('INVALID_ARGUMENT', 'actionId 参数不一致。')
          if (!record.response) fault('BUSY', '动作正在执行。')
          send(socket, { ...record.response!, requestId: r.requestId }); return
        }
        if (active) fault('BUSY', '已有动作执行中。')
        seen.set(r.actionId!, { signature })
        active = { request: r, socket, timer: setTimeout(() => { try { finish(execute(r)) } catch (e) { finish(fail(r, e)) } }, options.delayMs ?? 40), timeout: setTimeout(() => finish(fail(r, new StardewError('TIMEOUT', '模拟动作超时。'))), r.timeoutMs) }
      } catch (error) { send(socket, fail(r, error)) }
    })
    socket.on('close', () => { if (active?.socket === socket) finish(fail(active.request, new StardewError('CANCELLED', '连接已断开。'))) })
  })
  const address = server.address() as { port: number }
  return { endpoint: `ws://127.0.0.1:${address.port}/`, events, snapshot, close: async () => {
    if (active) finish(fail(active.request, new StardewError('CANCELLED', '模拟服务关闭。')))
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
