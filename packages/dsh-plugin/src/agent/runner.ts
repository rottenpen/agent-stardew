import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Command, Response, Snapshot } from '@agent-stardew/protocol'
import { candidatesFor, type Candidate, type ActionPolicy } from './candidates.js'
import { decide, type Decision, type DecisionOptions } from './jev-client.js'
import { PlayMemory, actionStateKey, dayKey, worldKey } from './memory.js'

export type RunStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'blocked' | 'needs_review' | 'completed'
export interface Completion { location?: string; exploredTiles?: number; cropId?: string; cropCount?: number; watered?: boolean; nextDay?: boolean; wateredCrops?: number; refill?: boolean }
export interface RunInput { goal: string; radius?: number; maxDecisions?: number; maxMinutes?: number; singleStep?: boolean; completion?: Completion; policy?: ActionPolicy }
export type CliCall = (command: Command, args: Record<string, unknown>, signal: AbortSignal, cwd: string, callId: string) => Promise<Response>
export interface RunnerOptions {
  call: CliCall; key: () => Promise<string | undefined>; enabled: boolean; timeoutMs: number; minConfidence: number
  cwd: string; fetch?: typeof fetch; intervalMs?: number
}
export interface RunEvent { at: string; kind: string; message: string; [key: string]: unknown }
export function validateInput(raw: RunInput): Required<Omit<RunInput, 'completion'>> & { completion?: Completion } {
  if (!raw || typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 2000) throw new Error('目标需要 1–2000 字。')
  const number = (v: unknown, fallback: number, min: number, max: number) => {
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`数值需要为 ${min}–${max} 的整数。`)
    return v
  }
  if (raw.singleStep !== undefined && typeof raw.singleStep !== 'boolean') throw new Error('singleStep 需要为布尔值。')
  if (raw.policy !== undefined && (!raw.policy || typeof raw.policy !== 'object' || Array.isArray(raw.policy) || Object.keys(raw.policy).some(k => k !== 'allowEmptySoilWatering') || (raw.policy.allowEmptySoilWatering !== undefined && typeof raw.policy.allowEmptySoilWatering !== 'boolean'))) throw new Error('动作策略无效。')
  let completion: Completion | undefined
  if (raw.completion !== undefined) {
    const c = raw.completion
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['location', 'exploredTiles', 'cropId', 'cropCount', 'watered', 'nextDay', 'wateredCrops', 'refill'].includes(k))) throw new Error('完成条件格式无效。')
    for (const k of ['location', 'cropId'] as const) if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k]!.trim() || c[k]!.length > 100)) throw new Error('地图名或作物 ID 无效。')
    if ((c.cropId === undefined) !== (c.cropCount === undefined)) throw new Error('作物 ID 和数量需要同时填写。')
    if (c.cropCount !== undefined) number(c.cropCount, 1, 1, 1000)
    if (c.exploredTiles !== undefined) number(c.exploredTiles, 1, 1, 65536)
    if (c.wateredCrops !== undefined) number(c.wateredCrops, 1, 1, 1000)
    for (const k of ['watered', 'nextDay', 'refill'] as const) if (c[k] !== undefined && typeof c[k] !== 'boolean') throw new Error('完成条件中的开关需要为布尔值。')
    if (c.watered && !c.cropId) throw new Error('浇水条件需要指定作物。')
    if (!c.location && !c.exploredTiles && !c.cropId && !c.nextDay && !c.wateredCrops && !c.refill) throw new Error('至少填写一个完成条件。')
    completion = { ...c }
  }
  return { goal: raw.goal.trim(), radius: number(raw.radius, 8, 1, 16), maxDecisions: number(raw.maxDecisions, 100, 1, 1000), maxMinutes: number(raw.maxMinutes, 15, 1, 120), singleStep: raw.singleStep ?? false, policy: { allowEmptySoilWatering: raw.policy?.allowEmptySoilWatering ?? false }, ...(completion ? { completion } : {}) }
}

export class JevRunner {
  private memory = new PlayMemory()
  private input: ReturnType<typeof validateInput> | null = null
  private current: Snapshot | null = null
  private initialDay = ''
  private initialWorld = ''
  private objective = ''
  private initialSeen = 0
  private controller: AbortController | null = null
  private task: Promise<void> | null = null
  private stopTarget: 'paused' | 'stopped' | null = null
  private recordTail: Promise<void> = Promise.resolve()
  private cwd: string
  private trace = ''
  private activeMs = 0
  private segmentStarted = 0
  private disposed = false
  private readTask: Promise<Snapshot> | null = null
  private listeners = new Set<(view: RunView) => void>()
  private state = {
    runId: null as string | null, revision: 0, status: 'idle' as RunStatus, phase: 'ready', reason: '', message: '输入目标，开始 Jev 自主游玩。',
    startedAt: null as string | null, updatedAt: new Date().toISOString(), decision: null as Decision | null,
    candidates: [] as Candidate[], events: [] as RunEvent[], inputTokens: 0, cost: 0, recordError: null as string | null,
  }
  constructor(private readonly options: RunnerOptions) { this.cwd = options.cwd }
  onSettled(listener: (view: RunView) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  recordPlan(plan: unknown) { this.event('plan', '阶段计划已更新。', { plan }) }
  get busy() { return this.task !== null || this.readTask !== null }
  view() {
    return structuredClone({ ...this.state, input: this.input, objective: this.objective, snapshot: this.current, memory: this.memory.summary(),
      enabled: this.options.enabled, elapsedMs: this.activeMs + (this.segmentStarted ? Date.now() - this.segmentStarted : 0),
      trace: this.trace || null, gameClock: '游戏时间遵循游戏自身规则；暂停 Agent 只停止自动控制。', chatModelCalls: 0 })
  }
  private event(kind: string, message: string, extra: Record<string, unknown> = {}) {
    this.state.updatedAt = new Date().toISOString()
    const event: RunEvent = { at: this.state.updatedAt, kind, message, ...extra }
    this.state.events.push({ at: event.at, kind, message, ...(extra.status ? { status: extra.status } : {}), ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.actionId ? { actionId: extra.actionId } : {}) })
    if (this.state.events.length > 40) this.state.events.shift()
    if (this.trace) {
      const trace = this.trace
      const status = JSON.stringify(this.view())
      this.recordTail = this.recordTail.then(async () => {
        await mkdir(trace, { recursive: true, mode: 0o700 })
        await appendFile(join(trace, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
        await writeFile(join(trace, 'status.tmp'), status + '\n', { mode: 0o600 })
        await rename(join(trace, 'status.tmp'), join(trace, 'status.json'))
      }).catch(() => { this.state.recordError = '运行记录写入失败。' })
    }
  }
  private terminal(status: RunStatus, reason: string, message: string) {
    this.state.status = status; this.state.reason = reason; this.state.message = message; this.state.phase = 'ready'
    this.event('status', message, { status, reason })
  }
  private async snapshot(signal: AbortSignal): Promise<Snapshot> {
    const response = await this.options.call('snapshot', { radius: this.input?.radius ?? 8 }, signal, this.cwd, `${this.state.runId ?? 'observe'}-${randomUUID()}`)
    if (response.status !== 'completed' || response.result.kind !== 'snapshot') throw new Error('error' in response ? `${response.error.code}: ${response.error.message}` : 'SNAPSHOT_FAILED')
    return response.result
  }
  async observe() {
    if (this.busy) return this.view()
    this.readTask = this.snapshot(AbortSignal.timeout(15000))
    try { this.current = await this.readTask; this.state.message = '已读取当前游戏。'; this.state.reason = '' }
    catch (error) { this.state.message = String(error); this.state.reason = 'OBSERVE_FAILED' }
    finally { this.readTask = null }
    return this.view()
  }
  start(raw: RunInput, cwd = this.options.cwd, carry?: { world: string | null; landmarks: ReturnType<PlayMemory['summary']>['landmarks']; objective: string }) {
    if (this.disposed) throw new Error('控制器已关闭。')
    if (this.busy) throw new Error('已有操作正在执行，请先暂停或停止。')
    const input = validateInput(raw)
    this.input = input; this.cwd = cwd; this.memory = new PlayMemory(); this.current = null
    this.objective = carry?.objective ?? input.goal
    this.initialDay = ''; this.initialWorld = carry?.world ?? ''; this.initialSeen = 0; this.activeMs = 0
    for (const landmark of carry?.landmarks ?? []) this.memory.landmarks.set(`${landmark.location}:${landmark.tile.x},${landmark.tile.y}:${landmark.kind}`, landmark)
    this.state = { ...this.state, runId: randomUUID(), revision: 1, status: 'running', phase: 'observing', reason: '', message: '正在观察游戏。',
      startedAt: new Date().toISOString(), decision: null, candidates: [], events: [], inputTokens: 0, cost: 0, recordError: null }
    this.trace = join(cwd, 'work', 'runs', `jev-${this.state.runId}`)
    this.event('start', 'Jev 自主游玩已启动。', { input, requestedModel: '~typesafe/jev-latest' })
    this.launch(input.singleStep)
    return this.view()
  }
  resume(singleStep = false, goal?: string) {
    if (this.disposed || this.busy || !this.input || !['paused', 'blocked', 'needs_review'].includes(this.state.status)) throw new Error('当前任务不能继续，请等待停止完成或创建新任务。')
    if (goal !== undefined && goal.trim() !== this.input.goal) {
      const next = validateInput({ ...this.input, goal, completion: undefined })
      this.input = next; this.objective = next.goal; this.state.revision++; this.state.decision = null
      this.event('goal', '目标已更新；完成条件需重新指定。', { goal: next.goal })
    }
    if (this.memory.apiCalls >= this.input.maxDecisions || this.activeMs >= this.input.maxMinutes * 60000) throw new Error('本次预算已耗尽，请创建新任务。')
    this.state.status = 'running'; this.state.reason = ''; this.state.message = '重新观察后继续。'
    this.launch(singleStep)
    return this.view()
  }
  private launch(singleStep: boolean) {
    this.controller = new AbortController(); this.stopTarget = null; this.segmentStarted = Date.now()
    const signal = this.controller.signal
    const budgetTimer = setTimeout(() => {
      if (!this.stopTarget) this.terminal('blocked', 'BUDGET_EXHAUSTED', '运行时限已到，正在停止自动操作。')
      this.controller?.abort()
    }, Math.max(1, this.input!.maxMinutes * 60000 - this.activeMs))
    this.task = this.loop(signal, singleStep).catch(error => {
      if (!signal.aborted) this.terminal('blocked', 'RUNTIME_ERROR', String(error))
    }).finally(async () => {
      clearTimeout(budgetTimer)
      this.activeMs += Date.now() - this.segmentStarted; this.segmentStarted = 0
      if (this.stopTarget) this.terminal(this.stopTarget, 'USER_CONTROL', this.stopTarget === 'paused' ? 'Agent 已暂停，可以修改目标后继续。' : '任务已停止。')
      else this.event('settled', this.state.message)
      await this.recordTail
      this.controller = null; this.task = null
      if (!this.disposed) for (const listener of this.listeners) {
        try { listener(this.view()) } catch { this.event('notice', '阶段结果回传失败，请在面板核对任务状态。') }
      }
    })
  }
  async halt(target: 'paused' | 'stopped') {
    if (this.task) {
      this.stopTarget = target === 'stopped' || this.stopTarget === 'stopped' ? 'stopped' : 'paused'
      this.state.status = this.stopTarget === 'stopped' ? 'stopping' : 'pausing'
      this.controller?.abort()
      await this.task
    } else if (this.input && this.state.status !== 'completed') this.terminal(target, 'USER_CONTROL', target === 'paused' ? 'Agent 已暂停。' : '任务已停止。')
    return this.view()
  }
  async dispose() { this.disposed = true; await this.halt('stopped'); await this.readTask?.catch(() => {}); await this.recordTail }
  private completionSatisfied(s: Snapshot) {
    const c = this.input?.completion
    if (!c) return false
    if (c.location && s.location !== c.location) return false
    if (c.exploredTiles && this.memory.seen.size - this.initialSeen < c.exploredTiles) return false
    if (c.nextDay && dayKey(s) === this.initialDay) return false
    if (c.wateredCrops && this.memory.waterings.size < c.wateredCrops) return false
    if (c.refill && this.memory.refills < 1) return false
    if (c.cropId) {
      const plants = [...this.memory.plantings.values()].filter(p => p.crop === c.cropId && (!c.watered || p.wateredDay === p.plantedDay))
      if (plants.length < c.cropCount!) return false
    }
    return true
  }
  private async loop(signal: AbortSignal, singleStep: boolean) {
    const input = this.input!
    let stalls = 0; let waiting = 0; let failures = 0
    while (!signal.aborted) {
      if (this.memory.apiCalls >= input.maxDecisions || this.activeMs + Date.now() - this.segmentStarted >= input.maxMinutes * 60000) {
        this.terminal('blocked', 'BUDGET_EXHAUSTED', '本次运行预算已用完，已停止自动操作。'); break
      }
      this.state.phase = 'observing'
      const before = await this.snapshot(signal)
      if (signal.aborted) break
      if (this.initialWorld && this.initialWorld !== worldKey(before)) { this.terminal('blocked', 'WORLD_CHANGED', '游戏实例或存档已切换，请核对后创建新任务。'); break }
      this.current = before; this.memory.observe(before)
      if (!this.initialDay) { this.initialWorld = worldKey(before); this.initialDay = dayKey(before); this.initialSeen = this.memory.seen.size }
      if (this.completionSatisfied(before)) { this.terminal('completed', 'VERIFIED', '完成条件已通过游戏观察与动作证据核验。'); break }
      if (!before.player.canMove && !before.menu) {
        if (++waiting >= 20) { this.terminal('blocked', 'GAME_NOT_READY', '角色持续不可操作，请检查动画或游戏暂停状态。'); break }
        this.state.message = '等待角色动画或场景过渡结束。'
        await delay(500, undefined, { signal }); continue
      }
      if (before.menu && !before.menu.options.length) { this.terminal('blocked', 'UNSUPPORTED_MENU', `当前菜单 ${before.menu.type} 尚无可执行选项，需要补齐该交互。`); break }
      const candidates = candidatesFor(before, this.memory.seen, this.memory.excluded, [...this.memory.landmarks.values()], input.policy)
      this.state.candidates = candidates; this.state.phase = 'deciding'; this.state.message = 'Jev 正在选择下一步。'
      const key = await this.options.key()
      if (signal.aborted) break
      const decision = await decide(before, input.goal, candidates, { enabled: this.options.enabled, apiKey: key, timeoutMs: this.options.timeoutMs, minConfidence: this.options.minConfidence, signal, fetch: this.options.fetch }, this.memory.summary(), { conditions: input.completion ?? null, initialDay: this.initialDay, observedSinceStart: this.memory.seen.size - this.initialSeen }, { objective: this.objective, policy: input.policy })
      if (decision.apiCalled) this.memory.apiCalls++
      this.state.decision = decision
      if (decision.model) this.memory.lastModel = decision.model
      this.state.inputTokens += decision.usage?.inputTokens ?? 0; this.state.cost += decision.usage?.cost ?? 0
      this.event('decision', decision.message, { decision, before, candidates })
      if (signal.aborted) break
      if (decision.status === 'finish') {
        this.terminal('needs_review', 'MODEL_FINISHED', input.completion ? 'Jev 建议结束，但指定完成条件尚未全部通过。' : 'Jev 建议任务完成，请根据现场记录核对自由目标。'); break
      }
      if (decision.status === 'waiting') {
        if (++waiting >= 3) { this.terminal('blocked', decision.reason, '连续等待或置信度不足，请检查当前观察和目标。'); break }
        await delay(700, undefined, { signal }); continue
      }
      if (!decision.recommendation) {
        if (['HTTP_429', 'HTTP_503', 'TIMEOUT', 'NETWORK_OR_RESPONSE_ERROR'].includes(decision.reason) && ++failures < 3) { await delay(failures * 1000, undefined, { signal }); continue }
        this.terminal('blocked', decision.reason, decision.message); break
      }
      failures = 0; waiting = 0
      const c = decision.recommendation
      // 模型等待期间可能有人操作游戏；刷新快照并重新绑定引用，条件改变则重新决策。
      const fresh = await this.snapshot(signal)
      if (signal.aborted) break
      if (worldKey(fresh) !== this.initialWorld) { this.terminal('blocked', 'WORLD_CHANGED', '存档已切换，本轮不执行。'); break }
      const actual = candidatesFor(fresh, this.memory.seen, this.memory.excluded, [...this.memory.landmarks.values()], input.policy).find(v => v.key === c.key)
      if (!actual) { this.event('refresh', '候选前提已改变，重新决策。'); continue }
      if (actionStateKey(fresh, actual) !== actionStateKey(before, c)) { this.current = fresh; this.event('refresh', '推理期间动作前提已变化，重新观察和决策。'); continue }
      this.state.phase = 'executing'; this.state.message = actual.label
      const actionId = `${this.state.runId}-${this.memory.steps + 1}`
      const response = await this.options.call(actual.tool.slice(8) as Command, { ...actual.args, actionId }, signal, this.cwd, actionId)
      this.memory.record(fresh, actual, response)
      this.event('action', actual.label, { candidate: actual, response, actionId })
      if (signal.aborted) break
      const after = response.status === 'completed' && response.result.kind === 'action' && response.result.snapshot ? response.result.snapshot : await this.snapshot(signal)
      if (signal.aborted) break
      const observed = this.memory.seen.size
      this.current = after; this.memory.observe(after)
      const noChange = response.status !== 'completed' || ('result' in response && response.result?.kind === 'action' && !response.result.changed)
      const recent = this.memory.history.slice(-6)
      const cycling = recent.length >= 6 && recent.every((h, i) => h.action === recent[i % 2].action) && this.memory.seen.size === observed
      stalls = noChange || cycling ? stalls + 1 : 0
      if (this.completionSatisfied(after)) { this.terminal('completed', 'VERIFIED', '完成条件已通过游戏观察与动作证据核验。'); break }
      if (stalls >= 5) { this.terminal('blocked', 'NO_PROGRESS', '相同动作持续失败或往返无进展，请查看行动记录。'); break }
      if (singleStep) { this.terminal('paused', 'SINGLE_STEP', '本次单步已结束。'); break }
      this.state.phase = 'observing'
      await delay(this.options.intervalMs ?? 250, undefined, { signal })
    }
  }
}
export type RunView = ReturnType<JevRunner['view']>
