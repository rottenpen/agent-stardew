import type { Snapshot, Tile } from '@agent-stardew/protocol'

export type Category = 'explore' | 'move' | 'select' | 'use' | 'interact' | 'menu'
export type Candidate = {
  id: string; category: Category; label: string; tool: string
  args: Record<string, string | number>; key: string; target?: Tile
}
export const tileKey = (p: Tile) => `${p.x},${p.y}`
export const distance = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const neighbors = (p: Tile) => [{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]
export const toolType = (item: Snapshot['inventory'][number]) => item.tool ?? (/^\(T\)(?:Copper|Steel|Gold|Iridium)?(Hoe|WateringCan|Axe|Pickaxe)$/.exec(item.itemId)?.[1])
const isSeeds = (item: Snapshot['inventory'][number]) => item.category === -74
export interface ActionPolicy { allowEmptySoilWatering?: boolean }

// 候选来自观察和游戏操作前提。目标的优先级、数量和步骤由 Jev 判断。
export function candidatesFor(snapshot: Snapshot, seen: ReadonlySet<string> = new Set(), excluded: ReadonlySet<string> = new Set(), landmarks: readonly { location: string; kind?: string; name: string; tile: Tile }[] = [], policy: ActionPolicy = {}): Candidate[] {
  const candidates: Candidate[] = []
  const counts = new Map<string, number>()
  const add = (category: Category, label: string, command: string, args: Candidate['args'], identity: string, target?: Tile) => {
    const key = `${snapshot.location}:${command}:${identity}`
    const family = category === 'move' ? ['work:', 'memory:', 'refill:'].find(prefix => identity.startsWith(prefix)) ?? 'object' : category
    if (excluded.has(key) || candidates.some(c => c.key === key) || (counts.get(family) ?? 0) >= (family === 'refill:' ? 8 : category === 'move' ? 16 : 48)) return
    candidates.push({ id: `c${candidates.length + 1}`, category, label, tool: `stardew_${command}`, args, key, ...(target ? { target } : {}) })
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  if (snapshot.menu) {
    for (const option of snapshot.menu.options) add('menu', `选择「${option.label}」；${snapshot.menu.text}`, 'menu', { target: option.ref }, `${snapshot.menu.type}:${snapshot.menu.text}:${option.label}`)
    return candidates
  }
  if (!snapshot.player.canMove) return []
  const position = snapshot.player.position
  const blocked = new Set(snapshot.entities.filter(e => !e.passable || e.kind === 'exit').map(e => tileKey(e.tile)))
  const walkable = new Set(snapshot.entities.filter(e => e.passable && !blocked.has(tileKey(e.tile))).map(e => tileKey(e.tile)))
  const reached = new Set([tileKey(position)])
  const queue = [position]
  for (let i = 0; i < queue.length; i++) for (const p of neighbors(queue[i])) {
    if (walkable.has(tileKey(p)) && !reached.has(tileKey(p))) { reached.add(tileKey(p)); queue.push(p) }
  }
  const adjacent = (p: Tile) => reached.has(tileKey(p)) || neighbors(p).some(n => reached.has(tileKey(n)))
  const entities = [...snapshot.entities].sort((a, b) => distance(position, a.tile) - distance(position, b.tile))
  const items = snapshot.inventory.filter(i => i.count > 0)
  const selected = items.find(i => i.slot === snapshot.player.selectedSlot)
  const useLabel = (item: Snapshot['inventory'][number], e: Snapshot['entities'][number]): string | undefined => {
    if (isSeeds(item) && e.tilled && !e.crop) return `播种 ${item.name}`
    const tool = toolType(item)
    if (tool === 'WateringCan' && e.refillable && item.water !== undefined && item.waterCapacity !== undefined && item.water < item.waterCapacity) return `给 ${item.name} 补水（${item.water}/${item.waterCapacity}）`
    if (snapshot.player.energy < 2) return
    if (tool === 'Hoe' && e.diggable && !e.tilled && !e.crop) return '耕地'
    if (tool === 'WateringCan' && (item.water ?? 0) > 0 && e.tilled && !e.watered && (e.crop ? e.needsWater !== false : policy.allowEmptySoilWatering)) return e.crop ? `给作物 ${e.crop} 浇水` : '预先浇空耕地'
    if ((tool === 'Axe' || tool === 'Pickaxe') && (e.kind === 'object' || e.kind === 'terrain')) return `尝试用 ${item.name} 处理 ${e.name}`
  }
  // 出口与交互点独立保留，避免农田占满移动候选。
  for (const e of entities) {
    if (!adjacent(e.tile)) continue
    const d = distance(position, e.tile)
    if (e.kind === 'exit' && d > 0) add('explore', `通过 ${e.name} (${tileKey(e.tile)})`, 'move', { near: e.ref }, `exit:${tileKey(e.tile)}`, e.tile)
    else if (['door', 'bed', 'npc', 'object', 'action', 'furniture'].includes(e.kind)) {
      if (d <= 1) add('interact', `与 ${e.name} 交互 (${tileKey(e.tile)})`, 'interact', { target: e.ref }, `${e.kind}:${tileKey(e.tile)}`, e.tile)
      else add('move', `靠近 ${e.name} 以便交互 (${tileKey(e.tile)})`, 'move', { near: e.ref }, `${e.kind}:${tileKey(e.tile)}`, e.tile)
    }
  }
  for (const landmark of landmarks) {
    if (landmark.location !== snapshot.location || entities.some(e => tileKey(e.tile) === tileKey(landmark.tile))) continue
    if (landmark.kind === 'water' && (!items.some(i => toolType(i) === 'WateringCan' && i.water !== undefined && i.waterCapacity !== undefined && i.water < i.waterCapacity)
      || entities.some(e => e.refillable && adjacent(e.tile)))) continue
    const next = queue.filter(p => distance(position, p) >= 2 && distance(p, landmark.tile) < distance(position, landmark.tile))
      .sort((a, b) => distance(a, landmark.tile) - distance(b, landmark.tile))[0]
    if (next) add('move', `沿已观察路线返回 ${landmark.name} 的上次位置 (${tileKey(landmark.tile)})：先到 (${tileKey(next)})，目标状态待重新观察`, 'move', { x: next.x, y: next.y }, `${landmark.kind === 'water' ? 'refill:memory' : 'memory'}:${tileKey(next)}`, next)
  }
  for (const item of items) {
    if (item.slot === snapshot.player.selectedSlot) continue
    const target = entities.find(e => adjacent(e.tile) && useLabel(item, e))
    if (target) add('select', `选择 ${item.name}（槽位 ${item.slot}）；现场可${useLabel(item, target)}，数量 ${item.count}`, 'select', { slot: item.slot }, `${item.slot}:${item.itemId}`)
  }
  for (const e of entities) {
    if (!adjacent(e.tile)) continue
    const useful = items.find(i => useLabel(i, e))
    if (!useful) continue
    if (distance(position, e.tile) > 1) add('move', `靠近 ${e.name} (${tileKey(e.tile)})，可${useLabel(useful, e)}`, 'move', { near: e.ref }, `${e.refillable ? 'refill' : 'work'}:${tileKey(e.tile)}`, e.tile)
    else if (selected) {
      const label = useLabel(selected, e)
      if (label) add('use', `${label}：${e.name} (${tileKey(e.tile)})`, 'use', { target: e.ref }, `${e.kind}:${tileKey(e.tile)}:${selected.itemId}`, e.tile)
    }
  }
  const radius = snapshot.observation.radius
  const gain = (p: Tile) => {
    let n = 0
    for (let y = Math.max(0, p.y - radius); y <= Math.min(snapshot.observation.height - 1, p.y + radius); y++)
      for (let x = Math.max(0, p.x - radius); x <= Math.min(snapshot.observation.width - 1, p.x + radius); x++) if (!seen.has(`${snapshot.location}:${x},${y}`)) n++
    return n
  }
  const frontier = queue.filter(p => distance(position, p) >= 2).map(p => ({ p, gain: gain(p) })).filter(v => v.gain > 0).sort((a, b) => b.gain - a.gain || distance(position, a.p) - distance(position, b.p))
  const chosen: Tile[] = []
  for (const { p, gain } of frontier) {
    if (chosen.some(n => distance(n, p) < Math.max(2, radius))) continue
    chosen.push(p)
    add('explore', `探索未观察区域：到 (${tileKey(p)})，预计新增 ${gain} 格观察`, 'move', { x: p.x, y: p.y }, tileKey(p), p)
    if (chosen.length >= 8) break
  }
  return candidates
}
