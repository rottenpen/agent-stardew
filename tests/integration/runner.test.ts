import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { startMock } from '../support/mock-server.js'
import { call } from '../../packages/cli/src/client.js'
import { JevRunner } from '../../packages/dsh-plugin/src/agent/runner.js'
import { StagePlanner } from '../../packages/dsh-plugin/src/agent/planner.js'

function response(body: any, category: string, id?: string) {
  return new Response(JSON.stringify({ id: 'model-fixture', model: 'typesafe/jev-fixture', answers: Object.fromEntries(Object.entries(body.questions).map(([key, raw]) => {
    const q = raw as any; const keys = Object.keys(q.criteria)
    const choice = key === 'intent' ? category : key === `action_${category}` && id ? id : keys[0]
    return [key, { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }]
  })) }))
}
async function settle(runner: JevRunner, limit = 6000) {
  const deadline = Date.now() + limit
  while (runner.busy && Date.now() < deadline) await wait(10)
  assert.equal(runner.busy, false, JSON.stringify(runner.view()))
  return runner.view()
}
async function fixture(t: any, fetcher: typeof fetch, delayMs = 1, water = 20) {
  const mock = await startMock({ delayMs, water })
  const cwd = await mkdtemp(join(tmpdir(), 'stardew-runner-'))
  const runner = new JevRunner({ cwd, enabled: true, timeoutMs: 1000, minConfidence: 0.35, intervalMs: 0, key: async () => 'test-only', fetch: fetcher,
    call: (command, raw, signal) => {
      const { actionId, ...args } = raw
      const params = command === 'move' && args.x !== undefined ? { tile: { x: args.x, y: args.y } } : args
      return call(command, params, { endpoint: mock.endpoint, timeoutMs: 2000, signal, actionId: actionId as string | undefined })
    },
  })
  t.after(async () => { await runner.dispose(); await mock.close(); await rm(cwd, { recursive: true, force: true }) })
  return { runner, mock, cwd }
}
test('[模型替身 + mock] 一次启动连续 20 次决策，预算结束后无后续动作', async t => {
  let n = 0
  const { runner, mock } = await fixture(t, async (_url, init) => {
    n++; const body = JSON.parse(String(init?.body))
    const c = body.state.candidates.find((c: any) => c.category === 'use') ?? body.state.candidates.find((c: any) => c.category === 'move' && c.label.includes('耕地'))
    assert.ok(c, JSON.stringify(body.state.candidates))
    return response(body, c.category, c.id)
  })
  runner.start({ goal: '整理空地', maxDecisions: 20 })
  const s = await settle(runner)
  assert.equal(s.reason, 'BUDGET_EXHAUSTED'); assert.equal(s.memory.apiCalls, 20); assert.equal(n, 20)
  assert.equal(s.memory.executedSteps, 20); assert.equal(s.chatModelCalls, 0)
  const size = mock.events.length; await wait(30); assert.equal(mock.events.length, size)
})

test('[模型替身 + mock] 空水壶找到水源并补水，返回播种和浇水；用资源变化验收', async t => {
  const { runner, mock } = await fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const candidates = body.state.candidates as { category: string; label: string; id: string }[]
    const c = candidates.find(c => c.category === 'use' && c.label.includes('补水'))
      ?? candidates.find(c => c.category === 'select' && c.label.includes('补水'))
      ?? candidates.find(c => c.category === 'move' && c.label.includes('补水'))
      ?? candidates.find(c => c.category === 'use' && /播种|浇水/.test(c.label))
      ?? candidates.find(c => c.category === 'select' && /播种|浇水/.test(c.label))
      ?? candidates.find(c => c.category === 'select' && c.label.includes('耕地'))
      ?? candidates.find(c => c.category === 'use')!
    assert.ok(c)
    return response(body, c.category, c.id)
  }, 1, 0)
  runner.start({ goal: '给空水壶补水，种一颗防风草并浇水', maxDecisions: 20, completion: { refill: true, cropId: '24', cropCount: 1, watered: true, wateredCrops: 1 } })
  const s = await settle(runner)
  assert.equal(s.status, 'completed', s.message)
  assert.equal(s.memory.refills, 1); assert.equal(s.memory.waterings.length, 1)
  assert.equal(mock.snapshot().inventory[1].water, 19)
  assert.ok(mock.events.some(e => e.command === 'move'))
})

test('[阶段交接替身 + mock] 回传原会话、共享预算、拒绝过期阶段和外部会话；手动接管不重启', async t => {
  const { runner, cwd } = await fixture(t, async (_url, init) => response(JSON.parse(String(init?.body)), 'finish'))
  const planner = new StagePlanner(runner); t.after(() => planner.dispose())
  const messages: string[] = []; const identity = {}
  const owner = { identity, sessionId: 'original-session', cwd, notify: (text: string) => messages.push(text) }
  const first = planner.start({ objective: '探索农场并观察农舍', goal: '探索农场', maxDecisions: 2, maxStages: 4 }, owner)
  await settle(runner)
  assert.equal(messages.length, 1); assert.equal(planner.view().planner?.phase, 'waiting')
  assert.match(messages[0], /MODEL_FINISHED/)
  const next = { planId: first.planner!.id, previousRunId: first.runId!, goal: '观察农舍', rationale: '根据上一阶段记录继续观察农舍' }
  assert.throws(() => planner.next(next, {}), /不属于本聊天/)
  planner.next(next, identity)
  assert.throws(() => planner.next(next, identity), /阶段已变化/)
  await settle(runner)
  assert.equal(messages.length, 2); assert.equal(planner.view().planner?.phase, 'exhausted')
  assert.equal(planner.view().planner?.stages.reduce((n, s) => n + s.apiCalls, 0), 2)
  assert.match(messages[1], /"continuationAllowed":false/)
  planner.manual('paused')
  assert.throws(() => planner.next({ ...next, previousRunId: runner.view().runId! }, identity), /手动控制结束/)
})

test('[阶段交接替身 + mock] 执行中手动暂停不发送自动续跑通知', async t => {
  const { runner, mock, cwd } = await fixture(t, async (_url, init) => response(JSON.parse(String(init?.body)), 'use'), 300)
  const planner = new StagePlanner(runner); t.after(() => planner.dispose())
  const messages: string[] = []
  planner.start({ objective: '整理空地', goal: '先观察并整理一片空地' }, { identity: {}, sessionId: 'owner', cwd, notify: text => messages.push(text) })
  while (!mock.events.some(e => e.command === 'use')) await wait(5)
  planner.manual('paused'); await runner.halt('paused')
  assert.equal(messages.length, 0); assert.equal(planner.view().planner?.phase, 'paused')
})

test('[模型替身 + mock] 停止丢弃迟到的 Jev 回答；新的任务正常执行', async t => {
  let release: (() => void) | undefined
  const { runner, mock } = await fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    await new Promise<void>(resolve => { release = resolve })
    return response(body, 'use')
  })
  runner.start({ goal: '耕地', singleStep: true })
  while (!release) await wait(5)
  const stopping = runner.halt('stopped'); release()
  await stopping
  assert.equal(runner.view().status, 'stopped')
  assert.ok(!mock.events.some(e => e.command === 'use'))
  release = undefined
  runner.start({ goal: '再耕一格地', singleStep: true })
  while (!release) await wait(5)
  ;(release as () => void)()
  assert.equal((await settle(runner)).status, 'paused')
  assert.equal(mock.events.filter(e => e.command === 'use').length, 1)
})

test('[模型替身 + mock] 游戏动作中的暂停传播到桥接，resume 先重新观察', async t => {
  const { runner, mock } = await fixture(t, async (_url, init) => response(JSON.parse(String(init?.body)), 'use'), 300)
  runner.start({ goal: '耕地' })
  while (!mock.events.some(e => e.command === 'use')) await wait(5)
  await runner.halt('paused')
  assert.equal(runner.view().status, 'paused')
  assert.ok(mock.events.some(e => e.command === 'stop'))
  assert.equal(mock.snapshot().entities.filter(e => e.tilled).length, 0)
  runner.resume(true)
  assert.equal((await settle(runner)).status, 'paused')
  assert.equal(mock.snapshot().entities.filter(e => e.tilled).length, 1)
})

test('[模型替身 + mock] 模型申请完成不替代游戏证据，单次启动可核验新种植和浇水', async t => {
  let finish = true
  const { runner } = await fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (finish) return response(body, 'finish')
    const candidates = body.state.candidates as { category: string; label: string; id: string }[]
    const c = candidates.find(c => c.category === 'use' && c.label.includes('播种'))
      ?? candidates.find(c => c.category === 'use' && c.label.includes('浇水'))
      ?? candidates.find(c => c.category === 'select' && c.label.includes('种子'))
      ?? candidates.find(c => c.category === 'select' && c.label.includes('浇水'))
      ?? candidates.find(c => c.category === 'use')!
    return response(body, c.category, c.id)
  })
  runner.start({ goal: '种一颗防风草并浇水', completion: { cropId: '24', cropCount: 1, watered: true } })
  assert.equal((await settle(runner)).status, 'needs_review')
  finish = false; runner.resume()
  const state = await settle(runner)
  assert.equal(state.status, 'completed'); assert.equal(state.memory.plantings.length, 1)
  assert.equal(state.memory.plantings[0].crop, '24')
})
