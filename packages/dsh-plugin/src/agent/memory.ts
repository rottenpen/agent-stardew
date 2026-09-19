import type { Response, Snapshot, Tile } from '@agent-stardew/protocol'
import type { Candidate } from './candidates.js'
import { tileKey } from './candidates.js'

export const worldKey = (s: Snapshot) => `${s.instanceId}:${s.saveGeneration}`
export const dayKey = (s: Snapshot) => `${s.date.year}:${s.date.season}:${s.date.day}`
export function stateKey(s: Snapshot) {
  return JSON.stringify([s.location, s.date, s.player, s.inventory, s.menu && [s.menu.type, s.menu.text, s.menu.options.map(o => o.label)], s.entities.map(({ ref: _, ...e }) => e)])
}
export function actionStateKey(s: Snapshot, c: Candidate) {
  const ref = c.args.target ?? c.args.near
  const target = s.entities.find(e => e.ref === ref)
  const fact = target ? (({ ref: _, ...rest }) => rest)(target) : null
  return JSON.stringify([worldKey(s), s.location, s.date, s.player, s.inventory,
    s.menu && [s.menu.type, s.menu.text, s.menu.options.map(o => o.label)], fact])
}
export class PlayMemory {
  private world = ''
  private failures = new Map<string, { candidate: Candidate; signature: string; targetKind?: string }>()
  readonly seen = new Set<string>()
  readonly excluded = new Set<string>()
  readonly history: { action: string; label: string; location: string; position: unknown; status: string; error?: string; detail?: string }[] = []
  readonly landmarks = new Map<string, { location: string; kind: string; name: string; tile: Tile; day: string }>()
  readonly plantings = new Map<string, { crop: string; location: string; tile: unknown; plantedDay: string; wateredDay: string | null }>()
  readonly waterings = new Map<string, { crop: string; location: string; tile: Tile; day: string }>()
  refills = 0
  apiCalls = 0
  steps = 0
  lastModel: string | null = null
  observe(s: Snapshot) {
    const world = worldKey(s)
    if (this.world && this.world !== world) throw new Error('WORLD_CHANGED')
    this.world = world
    for (const [key, failure] of this.failures) {
      const target = s.entities.find(e => e.kind === failure.targetKind && failure.candidate.target && tileKey(e.tile) === tileKey(failure.candidate.target))
      const candidate = { ...failure.candidate, args: { ...failure.candidate.args, ...(target && failure.candidate.args.target ? { target: target.ref } : {}), ...(target && failure.candidate.args.near ? { near: target.ref } : {}) } }
      if (actionStateKey(s, candidate) !== failure.signature) { this.excluded.delete(key); this.failures.delete(key) }
    }
    for (const e of s.entities) {
      const key = `${s.location}:${tileKey(e.tile)}`
      if (this.seen.size < 65536) this.seen.add(key)
      if (e.tilled || e.refillable || ['door', 'exit', 'bed', 'npc', 'water', 'object', 'action'].includes(e.kind)) {
        const kind = e.refillable ? 'water' : e.tilled ? 'soil' : e.kind
        const id = `${key}:${kind}`
        const clustered = kind === 'water' && [...this.landmarks.entries()].some(([k, l]) => k !== id && l.location === s.location && l.kind === kind && Math.abs(l.tile.x - e.tile.x) + Math.abs(l.tile.y - e.tile.y) < 4)
        if (!clustered) {
          this.landmarks.delete(id)
          this.landmarks.set(id, { location: s.location, kind, name: e.name, tile: e.tile, day: dayKey(s) })
          // 大片农田或池塘不能挤掉门、床和已发现的水源。
          const group = (k: string) => k === 'water' || k === 'soil' ? k : 'other'
          const limit = kind === 'water' ? 16 : kind === 'soil' ? 32 : 80
          const same = [...this.landmarks].filter(([, l]) => group(l.kind) === group(kind))
          if (same.length > limit) this.landmarks.delete(same[0][0])
        }
      }
      const planting = this.plantings.get(key)
      if (planting && e.crop === planting.crop && e.watered && !planting.wateredDay) planting.wateredDay = dayKey(s)
    }
  }
  record(s: Snapshot, c: Candidate, response: Response) {
    const failed = response.status !== 'completed'
    if (failed) {
      this.excluded.add(c.key); this.failures.set(c.key, { candidate: c, signature: actionStateKey(s, c), targetKind: s.entities.find(e => e.ref === (c.args.target ?? c.args.near))?.kind })
      if (this.failures.size > 128) { const oldest = this.failures.keys().next().value!; this.failures.delete(oldest); this.excluded.delete(oldest) }
    }
    const result = 'result' in response ? response.result : undefined
    this.history.push({ action: c.key, label: c.label, location: s.location, position: s.player.position, status: response.status,
      ...('error' in response ? { error: response.error.code, detail: response.error.message } : {}), ...(result?.kind === 'action' ? { detail: result.detail } : {}) })
    if (this.history.length > 20) this.history.shift()
    if (response.status === 'completed' && c.category === 'use' && c.target && result?.kind === 'action' && result.snapshot?.location === s.location && worldKey(result.snapshot) === worldKey(s)) {
      const before = s.entities.find(e => tileKey(e.tile) === tileKey(c.target!))
      const after = result.snapshot.entities.find(e => tileKey(e.tile) === tileKey(c.target!))
      if (!before?.crop && after?.crop) this.plantings.set(`${s.location}:${tileKey(c.target)}`, { crop: after.crop, location: s.location, tile: c.target, plantedDay: dayKey(s), wateredDay: after.watered ? dayKey(s) : null })
      if (before?.crop && before.crop === after?.crop && !before.watered && after.watered) this.waterings.set(`${s.location}:${tileKey(c.target)}`, { crop: after.crop, location: s.location, tile: c.target, day: dayKey(s) })
      const can = s.inventory.find(i => i.slot === s.player.selectedSlot)
      const filled = result.snapshot.inventory.find(i => i.slot === can?.slot && i.itemId === can?.itemId)
      if (before?.refillable && can?.water !== undefined && filled?.water !== undefined && filled.water > can.water) this.refills++
    }
    this.steps++
  }
  summary() {
    return { apiCalls: this.apiCalls, executedSteps: this.steps, lastModel: this.lastModel, observedTiles: this.seen.size,
      recentActions: this.history, landmarks: [...this.landmarks.values()], plantings: [...this.plantings.values()], waterings: [...this.waterings.values()], refills: this.refills }
  }
}
