import assert from 'node:assert/strict'
import test from 'node:test'
import { startMock } from '../support/mock-server.js'
import { candidatesFor } from '../../packages/dsh-plugin/src/agent/candidates.js'
import { PlayMemory } from '../../packages/dsh-plugin/src/agent/memory.js'
import { decide, decisionRequest, JEV_ENDPOINT, JEV_MODEL } from '../../packages/dsh-plugin/src/agent/jev-client.js'

export function answer(body: ReturnType<typeof decisionRequest>, category: string, pick?: string) {
  return { id: 'test-decision', model: 'typesafe/jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
    const keys = Object.keys(q.criteria)
    const choice = id === 'intent' ? category : id === `action_${category}` && pick ? pick : keys[0]
    return [id, { type: 'choice', choice, confidence: 0.98, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }]
  })) }
}
test('现场自动提供农务、交互和探索，不接收聊天模型动作；失败原地排除', async t => {
  const mock = await startMock(); t.after(() => mock.close())
  const s = mock.snapshot(); const memory = new PlayMemory(); memory.observe(s)
  const candidates = candidatesFor(s, memory.seen)
  assert.ok(candidates.some(c => c.category === 'use' && c.label.includes('耕地')))
  assert.ok(candidates.some(c => c.category === 'move' && c.label.includes('农舍')))
  assert.ok(!candidates.some(c => c.category === 'select' && c.args.slot === 2))
  const c = candidates.find(c => c.category === 'use')!
  memory.record(s, c, { protocolVersion: 1, requestId: 'r', status: 'failed', error: { code: 'PATH_BLOCKED', message: '阻挡', retryable: false } })
  memory.observe({ ...s, snapshotId: 'new' })
  assert.ok(!candidatesFor(s, memory.seen, memory.excluded).some(v => v.key === c.key))
  const translated = { ...s, inventory: s.inventory.map(i => ({ ...i, name: '不同语言' })), entities: s.entities.map(e => ({ ...e, name: '不同语言' })) }
  assert.equal(candidatesFor(translated).filter(c => c.category === 'use').length, candidates.filter(c => c.category === 'use').length)
  assert.throws(() => memory.observe({ ...s, saveGeneration: 2 }), /WORLD_CHANGED/)
})

test('一次 Decisions 请求独立选择 intent 与分支；严格拒绝无效概率及未知选项', async t => {
  const mock = await startMock(); t.after(() => mock.close())
  const s = mock.snapshot(); const candidates = candidatesFor(s)
  const options = { enabled: true, apiKey: 'test-only', timeoutMs: 1000, minConfidence: 0.35, signal: new AbortController().signal }
  let mutate: (v: any) => void = () => {}
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, JEV_ENDPOINT)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, JEV_MODEL)
    assert.equal(body.state.goal, '种下一颗种子')
    assert.ok(body.questions.intent)
    assert.ok(body.questions.action_use)
    const result = answer(body, 'use')
    mutate(result)
    return new Response(JSON.stringify(result))
  }
  const accepted = await decide(s, '种下一颗种子', candidates, { ...options, fetch: fake })
  assert.equal(accepted.status, 'selected'); assert.equal(accepted.apiCalled, true)
  assert.equal(accepted.recommendation?.category, 'use')
  mutate = r => { r.answers.action_use.choice = 'invented' }
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, fetch: fake })).reason, 'INVALID_RESPONSE')
  mutate = r => { r.answers.intent.probabilities.use = 0.2 }
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, fetch: fake })).reason, 'INVALID_RESPONSE')
  mutate = r => { r.answers.intent.confidence = 0.1 }
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, fetch: fake })).recommendation, null)
  const noCall: typeof fetch = async () => { throw new Error('不应调用网络') }
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, apiKey: '', fetch: noCall })).apiCalled, false)
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, signal: AbortSignal.abort(), fetch: noCall })).reason, 'CANCELLED')
  assert.equal((await decide(s, '种下一颗种子', candidates, { ...options, fetch: async () => new Response('secret-error', { status: 429 }) })).reason, 'HTTP_429')
})

test('浇水只选择需要水的作物；补水按容量、水源和可达性生成，不消耗体力前提', async t => {
  const mock = await startMock(); t.after(() => mock.close())
  const s = mock.snapshot(); s.player.selectedSlot = 1
  const empty = s.entities.find(e => e.tile.x === 2 && e.tile.y === 3)!
  const crop = s.entities.find(e => e.tile.x === 1 && e.tile.y === 2)!
  const wet = s.entities.find(e => e.tile.x === 2 && e.tile.y === 1)!
  const dead = s.entities.find(e => e.tile.x === 3 && e.tile.y === 2)!
  Object.assign(empty, { tilled: true, diggable: false })
  Object.assign(crop, { tilled: true, crop: '24', needsWater: true })
  Object.assign(wet, { tilled: true, crop: '24', watered: true, needsWater: false })
  Object.assign(dead, { tilled: true, crop: '24', needsWater: false })
  const targets = candidatesFor(s).filter(c => c.category === 'use').map(c => c.args.target)
  assert.deepEqual(targets, [crop.ref])
  assert.ok(candidatesFor(s, undefined, undefined, undefined, { allowEmptySoilWatering: true }).some(c => c.category === 'use' && c.args.target === empty.ref))
  assert.ok(!candidatesFor(s).some(c => c.label.includes('补水')))
  s.inventory[1].water = 0; s.player.position = { x: 5, y: 2 }; s.player.energy = 0
  assert.ok(candidatesFor(s).some(c => c.category === 'use' && c.label.includes('补水')))
  const source = s.entities.find(e => e.refillable)!
  for (const e of s.entities) if (Math.abs(e.tile.x - source.tile.x) + Math.abs(e.tile.y - source.tile.y) === 1) e.passable = false
  s.player.position = { x: 2, y: 2 }
  assert.ok(!candidatesFor(s).some(c => c.label.includes('补水')))
})
