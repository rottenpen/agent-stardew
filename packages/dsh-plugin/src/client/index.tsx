import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import styles from './style.css'

const ID = 'dsh-stardew/farm'
const KIND = 'stardew-farm'
const tools: Record<string, string> = {
  stardew_run_start: '开始农活', stardew_run_status: '查看任务', stardew_run_pause: '暂停农活',
  stardew_run_resume: '继续农活', stardew_run_stop: '停止农活',
  stardew_plan_start: '规划农活', stardew_plan_next: '接续阶段', stardew_plan_finish: '汇总任务',
}
const statuses: Record<string, string> = { idle: '尚未开始', running: '正在行动', pausing: '正在暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', blocked: '需要帮忙', needs_review: '待你复核', completed: '已核验完成' }
interface OpenFarm { openFarm(): void }

function FarmIcon({ size = 23 }: { size?: number }) {
  return <img src="/stardew/assets/app-icon-chicken-whale-v1.png" width={size} height={size} alt="" />
}
function FarmEntry({ openFarm }: OpenFarm) {
  return <Button variant="ghost" size="sm" className="stardew-entry" icon={<FarmIcon size={16} />} onClick={openFarm} aria-label="农场小助手" title="在右侧打开农场小助手"><span className="stardew-entry-label">农场小助手</span></Button>
}
function FarmPanel({ closeFarm }: { closeFarm(): void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow && event.data?.type === 'stardew:focus-chat') closeFarm()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [closeFarm])
  return <section className="stardew-dock" aria-label="农场小助手">
    <div className="stardew-dock-toolbar"><span>与聊天共享当前任务</span><a href="/stardew" target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button type="button" onClick={closeFarm}>收起</button></div>
    <iframe ref={frame} title="农场小助手运行面板" src="/stardew?embedded=1" />
  </section>
}

function object(text: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined } catch { return undefined }
}
function FarmTask({ block, toolName, openFarm, inspect }: ToolCallViewProps & OpenFarm) {
  const settled = 'kind' in block
  const call = settled ? block.call : block
  const args = object(call?.argsRaw ?? '')
  const raw = settled ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
  const result = object(raw)
  const error = settled && block.isError
  const status = !settled ? '正在提交' : error ? '操作未成功' : typeof result?.status === 'string' ? statuses[result.status] ?? result.status : '已返回'
  const goal = args?.objective ?? args?.goal
  const summary = typeof result?.message === 'string' ? result.message : error ? raw : undefined
  return <div className="stardew-task" data-error={error || undefined}>
    <div className="stardew-task-heading"><FarmIcon /><strong>{tools[toolName] ?? '农场任务'}</strong><span>{status}</span></div>
    {typeof goal === 'string' && <p>{goal}</p>}
    {summary && <p className="stardew-task-summary">{summary}</p>}
    <div className="stardew-task-actions"><button type="button" onClick={openFarm}>查看农场 →</button><span>打开当前任务面板</span>{inspect && <button type="button" className="stardew-inspect" onClick={inspect}>调用轨迹</button>}</div>
    <details><summary>本次调用记录</summary><pre>{call?.argsRaw}{raw ? '\n\n' + raw : ''}</pre></details>
  </div>
}

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']
export function apply(ctx: Context) {
  const openFarm = () => ctx.sidebarRight.openTab(KIND)
  const toggleFarm = () => {
    if (ctx.sidebarRight.isExpanded() && ctx.sidebarRight.active()?.kind === KIND) ctx.sidebarRight.toggleExpanded()
    else openFarm()
  }
  const closeFarm = () => { if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded() }
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.plugin = 'dsh-stardew'; style.textContent = styles
    document.head.append(style); return () => style.remove()
  }, 'stardew:client-style')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, title: () => '农场小助手' }), 'stardew:sidebar-type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, inject: () => ({ closeFarm }) }, FarmPanel,
  )), 'stardew:sidebar-body')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: ID, order: 30, inject: () => ({ openFarm: toggleFarm }) },
    FarmEntry,
  )), 'stardew:header-entry')
  for (const name of Object.keys(tools)) ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: name, inject: () => ({ openFarm }) }, FarmTask,
  )), `stardew:tool-card:${name}`)
}
