import assert from 'node:assert/strict'
import test from 'node:test'
import { call } from '../../packages/cli/src/client.ts'
import type { Command } from '../../packages/protocol/src/index.ts'
import { startMock } from '../support/mock-server.ts'

test('[mock] 经协议完成五块播种浇水、进屋、选睡觉并确认日期推进', async t => {
  const mock = await startMock({ delayMs: 1 }); t.after(mock.close)
  const run = async (command: Command, args: unknown) => { const r = await call(command, args, mock); assert.equal(r.status, 'completed', JSON.stringify(r)); return r }
  for (let x = 2; x <= 6; x++) {
    await run('move', { tile: { x, y: 2 } })
    const target = mock.snapshot().entities.find(e => e.tile.x === x && e.tile.y === 3)!.ref
    await run('select', { slot: 0 }); await run('use', { target })
    await run('select', { slot: 2 }); await run('use', { target })
    await run('select', { slot: 1 }); await run('use', { target })
  }
  const grown = mock.snapshot().entities.filter(e => e.crop && e.watered)
  assert.equal(grown.length, 5); assert.equal(mock.snapshot().inventory.some(i => i.slot === 2), false)
  let target = mock.snapshot().entities.find(e => e.kind === 'door')!.ref
  await run('move', { near: target }); await run('interact', { target })
  target = mock.snapshot().entities.find(e => e.kind === 'bed')!.ref
  await run('move', { near: target }); await run('interact', { target })
  await run('menu', { target: mock.snapshot().menu!.options[0].ref })
  assert.equal(mock.snapshot().date.day, 2)
  assert.equal(mock.snapshot().mode, 'mock')
})
