import type { Snapshot } from '@agent-stardew/protocol'
import type { Candidate, ActionPolicy } from './candidates.js'
export interface TaskContext { objective: string; policy: ActionPolicy }

export const JEV_MODEL = '~typesafe/jev-latest'
export const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
export interface DecisionOptions {
  enabled: boolean; apiKey?: string; timeoutMs: number; minConfidence: number; signal: AbortSignal; fetch?: typeof fetch
}
export interface ChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface Decision {
  status: 'selected' | 'waiting' | 'finish' | 'blocked'; reason: string; message: string; apiCalled: boolean
  requestedModel: string; elapsedMs: number; recommendation: Candidate | null
  model?: string; decisionId?: string | null; answers?: Record<string, ChoiceAnswer>
  usage?: { inputTokens: number | null; outputTokens: number | null; cost: number | null }
}
const categories: Record<string, string> = {
  explore: '探索新的区域或通过出口寻找目标和资源。', move: '靠近已观察的工作目标或交互对象。',
  select: '选择下一次操作需要的工具或物品；选择后重新观察。', use: '向相邻目标使用当前手持工具或种子。',
  interact: '与已观察且相邻的门、床、NPC 或对象交互。', menu: '选择当前菜单提供的一个选项。',
}
const rules = '你直接控制星露谷。围绕 objective 总目标及其约束，根据 goal 当前阶段、现场和历史自主选择下一步。数量和指定物品必须匹配目标。缺资源时探索已知线索与新区域；水壶空时找到可达水源，选择水壶并朝水源使用，水量增加才算补水成功。水源未在视野内不代表不存在，可返回记忆中的水源或继续探索。默认只浇需要水的作物；policy 明确允许预浇空地时可按目标预浇，已浇水地块不重复操作。重复失败或往返没有进展时换方法。睡觉只有目标允许且当日要求已有证据满足时才确认。选择工具本身不等于完成使用，行动结果以游戏返回为准。候选按类别有数量上限，地图范围外仍然未知。历史地标是旧观察，不能当作当前位置事实。'

export function decisionRequest(snapshot: Snapshot, goal: string, candidates: Candidate[], memory: unknown, completion: unknown, context?: TaskContext) {
  const criteria: Record<string, string> = {}
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {}
  for (const category of Object.keys(categories)) {
    const group = candidates.filter(c => c.category === category)
    if (!group.length) continue
    criteria[category] = `${categories[category]} 可选：${group.map(c => c.id).join(', ')}`
    questions[`action_${category}`] = { type: 'choice', instructions: `${rules} 假设本轮选择 ${category}，选最能推进目标的具体动作。本答案只在 intent 选择此类别时执行。`, criteria: Object.fromEntries(group.map(c => [c.id, c.label])) }
  }
  Object.assign(criteria, { wait: '现场处于动画或短暂过渡，暂时等待再观察；正常可操作时不要反复等待。', finish: '用户全部要求已有观察证据满足，申请结束；仍需控制器核对完成条件。', blocked: '已知操作无法推进目标，存在具体能力缺口或资源获取途径已穷尽。' })
  return { model: JEV_MODEL, state: {
    goal, objective: context?.objective ?? goal, policy: context?.policy ?? { allowEmptySoilWatering: false }, completion, memory, location: snapshot.location, date: snapshot.date, time: snapshot.time,
    player: snapshot.player, inventory: snapshot.inventory, menu: snapshot.menu, observation: snapshot.observation,
    entities: snapshot.entities.filter(e => e.kind !== 'tile' || e.tilled || e.crop), candidates,
  }, questions: { intent: { type: 'choice', instructions: `${rules} 比较各类别中最佳动作，选择本轮最有用的类别。`, criteria }, ...questions } }
}
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
export function validAnswer(raw: unknown, choices: string[]): raw is ChoiceAnswer {
  const a = raw as ChoiceAnswer
  if (!a || a.type !== 'choice' || !choices.includes(a.choice) || !unit(a.confidence) || !a.probabilities || Array.isArray(a.probabilities)) return false
  if (Object.keys(a.probabilities).sort().join('\n') !== [...choices].sort().join('\n')) return false
  const p = Object.values(a.probabilities)
  return p.every(unit) && Math.abs(p.reduce((n, v) => n + v, 0) - 1) <= 0.025 && a.probabilities[a.choice] >= Math.max(...p) - 0.001
}
export async function decide(snapshot: Snapshot, goal: string, candidates: Candidate[], options: DecisionOptions, memory: unknown = {}, completion: unknown = null, context?: TaskContext): Promise<Decision> {
  const started = Date.now()
  let apiCalled = false
  const result = (reason: string, message: string, status: Decision['status'] = 'blocked'): Decision => ({ status, reason, message, apiCalled, requestedModel: JEV_MODEL, elapsedMs: Date.now() - started, recommendation: null })
  if (options.signal.aborted) return result('CANCELLED', '决策已取消。')
  if (!options.enabled) return result('DISABLED', '请使用 --jev 启动自主游玩。')
  if (!options.apiKey?.trim()) return result('MISSING_CREDENTIAL', '请在 dsh 凭据或项目 .env 中设置 OPENROUTER_API_KEY。')
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const body = decisionRequest(snapshot, goal, candidates, memory, completion, context)
  try {
    apiCalled = true
    const response = await (options.fetch ?? fetch)(JEV_ENDPOINT, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'agent-stardew' }, body: JSON.stringify(body),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return result(`HTTP_${response.status}`, response.status === 401 || response.status === 403 ? 'OpenRouter Key 无效或无访问权限。' : response.status === 402 ? 'OpenRouter 额度不足。' : `Jev 请求失败（HTTP ${response.status}）。`)
    }
    const reader = response.body?.getReader()
    if (!reader) return result('INVALID_RESPONSE', 'Jev 返回空响应。')
    const chunks: Uint8Array[] = []; let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 262144) { await reader.cancel(); return result('INVALID_RESPONSE', 'Jev 响应超出大小限制。') }
      chunks.push(value)
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof data.model !== 'string' || !data.answers || Object.keys(data.answers).sort().join() !== Object.keys(body.questions).sort().join()) return result('INVALID_RESPONSE', 'Jev 返回的问题集合不匹配。')
    for (const [id, question] of Object.entries(body.questions)) if (!validAnswer(data.answers[id], Object.keys(question.criteria))) return result('INVALID_RESPONSE', `Jev 的 ${id} 选择或概率不符合当前候选。`)
    const answers = data.answers as Record<string, ChoiceAnswer>
    const intent = answers.intent
    const child = answers[`action_${intent.choice}`]
    const candidate = child ? candidates.find(c => c.category === intent.choice && c.id === child.choice) : undefined
    const accepted = intent.confidence >= options.minConfidence && (!child || child.confidence >= options.minConfidence)
    const usage = data.usage
    return {
      ...result(accepted ? intent.choice.toUpperCase() : 'LOW_CONFIDENCE', accepted ? candidate?.label ?? (intent.choice === 'finish' ? 'Jev 申请结束，正在核对证据。' : intent.choice === 'wait' ? '等待现场变化后重新观察。' : 'Jev 判断当前目标受阻。') : '置信度不足，重新观察后再判断。',
        !accepted ? 'waiting' : candidate ? 'selected' : intent.choice === 'finish' ? 'finish' : intent.choice === 'wait' ? 'waiting' : 'blocked'),
      model: data.model, decisionId: typeof data.id === 'string' ? data.id : null, answers,
      usage: { inputTokens: Number.isFinite(usage?.input_tokens) ? usage.input_tokens : null, outputTokens: Number.isFinite(usage?.output_tokens) ? usage.output_tokens : null, cost: Number.isFinite(usage?.cost) ? usage.cost : null },
      recommendation: accepted ? candidate ?? null : null,
    }
  } catch {
    return result(options.signal.aborted ? 'CANCELLED' : signal.aborted ? 'TIMEOUT' : 'NETWORK_OR_RESPONSE_ERROR', 'Jev 请求未完成，本次未提交游戏动作。')
  }
}
