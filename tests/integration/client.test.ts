import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { call } from '../../packages/cli/src/client.ts'
import { startMock } from '../support/mock-server.ts'
import type { Response } from '../../packages/protocol/src/index.ts'
function code(response: Response) { return response.status === 'failed' || response.status === 'cancelled' ? response.error.code : undefined }

test('握手区分未加载存档、协议不兼容和多人存档', async t => {
  for (const [options, expected] of [[{ saveLoaded: false }, 'NO_SAVE_LOADED'], [{ protocolVersion: 2 }, 'INCOMPATIBLE_PROTOCOL'], [{ singlePlayer: false }, 'UNSUPPORTED']] as const) {
    const mock = await startMock(options); t.after(mock.close)
    assert.equal(code(await call('snapshot', {}, mock)), expected)
  }
})
test('活动动作可查询；并发写拒绝；重放相同 ID 不重复执行，不同参数被拒绝', async t => {
  const mock = await startMock({ delayMs: 150 }); t.after(mock.close)
  const action = call('select', { slot: 1 }, { ...mock, actionId: 'select-1' })
  while (!mock.events.some(e => e.command === 'select')) await wait(5)
  const status = await call('status', {}, mock)
  assert.equal(status.status, 'completed')
  if (status.status === 'completed' && status.result.kind === 'status') assert.equal(status.result.activeActionId, 'select-1')
  assert.equal(code(await call('select', { slot: 2 }, mock)), 'BUSY')
  assert.equal((await action).status, 'completed')
  const repeated = await call('select', { slot: 1 }, { ...mock, actionId: 'select-1' }); assert.equal(repeated.status, 'completed')
  assert.equal(code(await call('select', { slot: 2 }, { ...mock, actionId: 'select-1' })), 'INVALID_ARGUMENT')
  assert.equal(mock.snapshot().player.selectedSlot, 1)
})
test('取消和超时发送 stop，服务端停止后不再改变位置', async t => {
  const mock = await startMock({ delayMs: 500 }); t.after(mock.close)
  const controller = new AbortController()
  const pending = call('move', { tile: { x: 3, y: 3 } }, { ...mock, signal: controller.signal })
  while (!mock.events.some(e => e.command === 'move')) await wait(5)
  controller.abort(); assert.equal(code(await pending), 'CANCELLED')
  assert.ok(mock.events.some(e => e.command === 'stop'))
  await wait(550); assert.deepEqual(mock.snapshot().player.position, { x: 2, y: 2 })
  assert.equal(code(await call('move', { tile: { x: 3, y: 3 } }, { ...mock, timeoutMs: 100 })), 'TIMEOUT')
  await wait(550); assert.deepEqual(mock.snapshot().player.position, { x: 2, y: 2 })
})
test('过期引用、阻挡和距离错误保持可区分', async t => {
  const mock = await startMock({ delayMs: 1 }); t.after(mock.close)
  assert.equal(code(await call('use', { target: '@s999:e1' }, mock)), 'STALE_REF')
  assert.equal(code(await call('move', { tile: { x: 5, y: 5 } }, mock)), 'PATH_BLOCKED')
  const far = mock.snapshot().entities.find(e => e.tile.x === 7 && e.tile.y === 7)!
  assert.equal(code(await call('use', { target: far.ref }, mock)), 'OUT_OF_REACH')
})
