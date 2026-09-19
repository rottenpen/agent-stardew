import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEndpoint, requestSchema, responseSchema, commandSchemas } from '../../packages/protocol/src/index.ts'
import { startMock } from '../support/mock-server.ts'

test('协议拒绝远程地址、额外参数、互斥目标和不完整写请求', () => {
  for (const url of ['ws://example.com/', 'ws://127.0.0.1/?token=x', 'wss://127.0.0.1/', 'ws://u:p@localhost/']) assert.throws(() => parseEndpoint(url))
  assert.equal(parseEndpoint('ws://localhost:1234'), 'ws://127.0.0.1:1234/')
  assert.equal(commandSchemas.move.safeParse({ tile: { x: 1, y: 2 }, near: '@s1:e1' }).success, false)
  assert.equal(commandSchemas.select.safeParse({ slot: 36 }).success, false)
  assert.equal(commandSchemas.use.safeParse({ target: '@s1:e1', extra: true }).success, false)
  assert.equal(requestSchema.safeParse({ protocolVersion: 1, requestId: 'r', command: 'select', args: { slot: 1 }, timeoutMs: 500 }).success, false)
})
test('快照包含明确的模拟来源，空菜单和活动状态字段不能缺失', async t => {
  const mock = await startMock(); t.after(mock.close)
  assert.equal(responseSchema.safeParse({ protocolVersion: 1, requestId: 'r', status: 'completed', result: mock.snapshot() }).success, true)
  assert.equal(responseSchema.safeParse({ protocolVersion: 1, requestId: 'r', status: 'completed', result: { kind: 'status' } }).success, false)
})
