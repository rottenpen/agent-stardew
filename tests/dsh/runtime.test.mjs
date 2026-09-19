import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { startMock } from '../../work/test-support/mock-server.mjs'

const require = createRequire(new URL('../../packages/dsh-plugin/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Skills } = await load('@deepseek-ai/dsh-skill')
const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
const plugin = await import('../../packages/dsh-plugin/dist/index.js')
let seq = 0
async function fixture(t, options, config = {}) {
  const mock = await startMock(options)
  const ctx = new Context()
  const fibers = []
  for (const service of [SystemPrompt, Tools, Skills, Subprocess]) fibers.push(await ctx.plugin(service))
  const fork = ctx.plugin(plugin, { endpoint: mock.endpoint, cliPath: fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), timeoutMs: 2000, maxOutputBytes: 4194304, ...config })
  fibers.push(await fork)
  t.after(async () => { try { for (const fiber of fibers.reverse()) await fiber.dispose() } finally { await mock.close() } })
  return { ctx, mock, call: (name, args, signal = new AbortController().signal, agent) => ctx.tools.execute({ callId: `stardew-test-${++seq}`, name: `stardew_${name}`, arguments: args, signal, agent }) }
}

test('真实 dsh 注册器和本机 subprocess 加载构建产物，返回规范 JSON 与文本', async t => {
  const { call } = await fixture(t)
  const result = await call('snapshot', { radius: 2 })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.ok(JSON.stringify(result).includes('mock'))
  assert.ok(JSON.stringify(result).includes('snapshotId'))
  const invalid = await call('select', { slot: 'bad' })
  assert.equal(invalid.isError, true)
  const selected = await call('select', { slot: 1 })
  assert.equal(selected.isError, false, JSON.stringify(selected))
})

test('随包 skill 注册最新正文，所有工具和 JSON 示例匹配真实注册器', async t => {
  const { ctx, call } = await fixture(t)
  const source = await readFile(new URL('../../packages/dsh-plugin/skills/stardew/SKILL.md', import.meta.url), 'utf8')
  const skill = await ctx.skills.get('stardew')
  assert.equal(skill.content, source.replace(/^---\n[\s\S]*?\n---\n/, ''))
  assert.equal(skill.description, /^description: (.+)$/m.exec(source)[1])
  for (const name of new Set(source.match(/\bstardew_(?:run_|plan_)?[a-z]+\b/g))) assert.ok(ctx.tools.get(name), `skill 引用了未注册工具：${name}`)
  const examples = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))
  assert.equal(examples.length, 3)
  const agent = { ctx, status: 'idle', options: {}, session: { id: 'skill-examples', header: { cwd: fileURLToPath(new URL('../../work/tests', import.meta.url)) } }, followup() {}, inject() {} }
  for (const example of examples) {
    const result = await call(example.tool.slice('stardew_'.length), example.arguments, undefined, agent)
    assert.equal(result.isError, false, JSON.stringify(result))
    await call('run_stop', {}, undefined, agent)
  }
})

test('真实 dsh 注册器把阶段结果作为插件消息回传原聊天，停用控制器后不重新执行', async t => {
  const { ctx, call } = await fixture(t, undefined, { jevEnabled: true })
  const notices = []
  const agent = { ctx, status: 'idle', options: { model: 'planner-fixture' }, session: { id: 'original-chat', header: { cwd: fileURLToPath(new URL('../../work/tests', import.meta.url)) } },
    followup: message => notices.push(message), inject: () => { throw new Error('空闲会话应当唤醒') } }
  // 地图条件由快照即可核验，不发送网络模型请求。
  const started = await call('plan_start', { objective: '确认已经在农场', goal: '核对地图', completion: { location: 'Farm' } }, undefined, agent)
  assert.equal(started.isError, false, JSON.stringify(started))
  const deadline = Date.now() + 5000
  while (!notices.length && Date.now() < deadline) await wait(20)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].source.kind, 'plugin')
  assert.equal(notices[0].source.plugin, 'stardew')
  const text = notices[0].content.find(c => c.type === 'text').text
  const evidence = JSON.parse(text.slice(text.indexOf('\n') + 1))
  assert.equal(evidence.status, 'completed'); assert.equal(evidence.reason, 'VERIFIED')
  assert.equal(evidence.game.mode, 'mock')
  const denied = await call('run_start', { goal: '不能重开以重置计划预算' }, undefined, agent)
  assert.equal(denied.isError, true)
  assert.equal((await call('run_pause', {}, undefined, agent)).isError, false)
  const late = await call('plan_next', { planId: evidence.planId, previousRunId: evidence.previousRunId, goal: '继续探索', rationale: '旧通知' }, undefined, agent)
  assert.equal(late.isError, true)
})
test('dsh 取消实际 CLI 子进程后，模拟游戏不再执行写动作', async t => {
  const { call, mock } = await fixture(t, { delayMs: 1200 })
  const controller = new AbortController()
  const pending = call('move', { x: 3, y: 3 }, controller.signal)
  const deadline = Date.now() + 4000
  while (!mock.events.some(e => e.command === 'move') && Date.now() < deadline) await wait(10)
  assert.ok(mock.events.some(e => e.command === 'move'))
  controller.abort(); await pending
  await wait(1300)
  assert.deepEqual(mock.snapshot().player.position, { x: 2, y: 2 })
  assert.ok(mock.events.some(e => e.command === 'stop'))
})
test('Jev 运行工具在真实 dsh 注册器启动独立循环，关闭时不执行动作', async t => {
  const { call, mock } = await fixture(t)
  const started = await call('run_start', { goal: '探索农场' })
  assert.equal(started.isError, false, JSON.stringify(started))
  await wait(500)
  const result = await call('run_status', {})
  assert.ok(JSON.stringify(result).includes('DISABLED'), JSON.stringify(result))
  assert.ok(!mock.events.some(e => ['move', 'use'].includes(e.command)))
})

test('真实 dsh 一次启动后自动连续调用 Jev，控制工具停止后台循环', async t => {
  const { call, mock } = await fixture(t, undefined, { jevEnabled: true })
  const originalFetch = globalThis.fetch; const originalKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-only'
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions')
    const body = JSON.parse(options.body)
    return new Response(JSON.stringify({ id: 'test-choice', model: 'typesafe/jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria); const choice = id === 'intent' ? 'use' : keys[0]
      return [id, { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }]
    })) }))
  }
  t.after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey })
  const result = await call('run_start', { goal: '整理土地', maxDecisions: 3 })
  assert.equal(result.isError, false, JSON.stringify(result))
  const deadline = Date.now() + 7000
  while (calls < 3 && Date.now() < deadline) await wait(40)
  assert.equal(calls, 3)
  const stopped = await call('run_stop', {})
  assert.equal(stopped.isError, false, JSON.stringify(stopped))
  assert.ok(mock.events.some(e => e.command === 'use'))
  assert.equal((await call('move', { x: 4, y: 2 })).isError, true)
})
