import { startMock } from '../tests/support/mock-server.ts'
const port = Number(process.env.STARDEW_MOCK_PORT ?? 17655)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STARDEW_MOCK_PORT 必须为 1–65535。')
const mock = await startMock({ port })
console.log(`[mock] 模拟服务：${mock.endpoint}；没有连接真实游戏。`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void mock.close())
