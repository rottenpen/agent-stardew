import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, failure, StardewError, writes, parseEndpoint, render, responseJsonSchema, responseSchema } from '@agent-stardew/protocol'
import type { Command, Response } from '@agent-stardew/protocol'

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JevRunner, type RunInput } from './agent/runner.js'
import { StagePlanner, type PlanInput, type NextStage } from './agent/planner.js'
import { mountPanel } from './agent/web.js'

export const name = 'stardew'
export const inject = ['tools', 'subprocess', 'skills', 'systemPrompt']
export interface Config { endpoint: string; cliPath: string; timeoutMs: number; maxOutputBytes: number; jevEnabled?: boolean; jevTimeoutMs?: number; jevMinConfidence?: number }
export const Config = z.object({
  jevEnabled: z.boolean().default(false).description('启用 OpenRouter Jev 自主游玩控制器'),
  jevTimeoutMs: z.number().min(100).max(30000).default(8000).description('Jev 请求时限（毫秒）'),
  jevMinConfidence: z.number().min(0).max(1).default(0.35).description('低于此置信度时重新观察，连续不足则暂停任务'),
  endpoint: z.string().default(DEFAULT_ENDPOINT).description('本机 Mod WebSocket 地址'),
  cliPath: z.string().default('').description('CLI 的 JavaScript 入口；留空时从依赖解析'),
  timeoutMs: z.number().min(100).max(120000).default(DEFAULT_TIMEOUT_MS).description('单次调用时限（毫秒）'),
  maxOutputBytes: z.number().min(4096).max(MAX_RESPONSE_BYTES).default(MAX_RESPONSE_BYTES).description('CLI stdout 最大字节数'),
})

// dsh 的 schema DSL 将 required 放在字段上；运行时继续用共享协议校验完整约束。
export function toDshSchema(raw: Record<string, unknown>): ValueSchemaSpec {
  const variants = raw.oneOf ?? raw.anyOf
  if (Array.isArray(variants)) return { oneOf: variants.map(v => toDshSchema(v)) as [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] }
  if (raw.type === 'object') {
    const required = (raw.required ?? []) as string[]
    const properties: ParameterSchemaSpec = {}
    for (const [key, value] of Object.entries(raw.properties as Record<string, Record<string, unknown>> ?? {})) {
      properties[key] = { ...toDshSchema(value), ...(required.includes(key) ? { required: true as const } : {}) }
    }
    return { type: 'object', properties, additionalProperties: raw.additionalProperties !== false }
  }
  if (raw.type === 'array') return { type: 'array', items: toDshSchema(raw.items as Record<string, unknown>) }
  if (['string', 'number', 'integer', 'boolean', 'null'].includes(raw.type as string)) return { type: raw.type, ...(raw.const === undefined ? {} : { const: raw.const }), ...(raw.enum ? { enum: raw.enum } : {}) } as ValueSchemaSpec
  throw new Error(`不支持的协议 schema：${JSON.stringify(raw)}`)
}

const parameters: Record<Command, ParameterSchemaSpec> = {
  doctor: {},
  snapshot: { radius: { type: 'integer', description: '观察半径，1–16，默认 8；远处未观察不代表不存在。' } },
  move: { x: { type: 'integer', description: '当前地图绝对格子 x；必须同时提供 y。' }, y: { type: 'integer' }, near: { type: 'string', description: '移到快照目标引用附近；与 x/y 互斥。' } },
  select: { slot: { type: 'integer', required: true, description: '背包槽位，从 0 开始。' } },
  use: { target: { type: 'string', required: true, description: '最新快照中的地块或目标引用。' } },
  interact: { target: { type: 'string', required: true } },
  menu: { target: { type: 'string', required: true, description: '当前菜单选项引用，如 @s18:m1。' } },
  screenshot: { output: { type: 'string', required: true, description: '新 PNG 文件的本机路径。' } },
  status: {}, stop: { actionId: { type: 'string', description: '仅停止指定动作；不填则停止当前动作。' } },
}
const descriptions: Record<Command, string> = {
  doctor: '检查星露谷 Mod 连接、版本和是否加载存档。',
  snapshot: '观察星露谷当前地图、日期、体力、背包、附近目标与菜单，取得动作引用。',
  move: '沿可走路径移动到当前地图绝对格子或目标附近，等待到达。',
  select: '选择背包槽位中的工具或物品。',
  use: '朝目标使用已选工具或种子，检查耕地、播种、浇水或水壶补水结果。',
  interact: '与附近目标交互，例如门、床或对象，并返回当前状态。',
  menu: '选择当前快照给出的菜单选项，等待状态稳定。',
  screenshot: '保存当前游戏画面为新的本机 PNG 文件。',
  status: '查询游戏中正在执行的动作。', stop: '停止自动动作并释放移动控制。',
}
function argvFor(command: Command, args: Record<string, unknown>): string[] {
  const argv: string[] = [command]
  if (command === 'move') {
    if (args.near !== undefined && (args.x !== undefined || args.y !== undefined)) throw new Error('near 与 x/y 互斥。')
    if (args.near !== undefined) argv.push('--near', String(args.near))
    else if (Number.isInteger(args.x) && Number.isInteger(args.y)) argv.push('--tile', String(args.x), String(args.y))
    else throw new Error('move 需要 x、y 或 near。')
  }
  if (command === 'snapshot' && args.radius !== undefined) argv.push('--radius', String(args.radius))
  if (command === 'select') argv.push('--slot', String(args.slot))
  if (command === 'use' || command === 'interact') argv.push(String(args.target))
  if (command === 'menu') argv.push('choose', String(args.target))
  if (command === 'screenshot') argv.push('--output', String(args.output))
  if ((command === 'stop' || writes.has(command)) && args.actionId !== undefined) argv.push('--action-id', String(args.actionId))
  return argv
}

export function apply(ctx: Context, config: Config) {
  const endpoint = parseEndpoint(config.endpoint)
  const cli = config.cliPath || createRequire(import.meta.url).resolve('agent-stardew/bin')
  async function runCli(command: Command, args: Record<string, unknown>, signal: AbortSignal, cwd: string, callId: string): Promise<Response> {
    let argv: string[]
    try { argv = argvFor(command, args) } catch (error) { return failure(randomUUID(), new StardewError('INVALID_ARGUMENT', String(error))) }
    if (writes.has(command) && args.actionId === undefined) argv.push('--action-id', createHash('sha256').update(String(callId)).digest('hex'))
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs + 2000)])
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, cli, ...argv, '--json', '--endpoint', endpoint, '--timeout', String(config.timeoutMs)],
      cwd, signal: combinedSignal, graceMs: 1500,
      stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: 16384 } },
    })
    try {
      const outcome = await handle.done
      const output = handle.collected.stdout?.readFrom(0)
      if (!output || output.lossy) throw new Error('CLI 输出缺失或超出上限。')
      const response = responseSchema.parse(JSON.parse(output.text))
      if (outcome.exitCode === null) throw new Error('CLI 被终止，请重新观察游戏状态。')
      return response
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
  // 动态生成的联合各分支均为 JSON 对象；此处只放宽 TS 推导，运行时仍保留完整联合 schema。
  const outputSchema = toDshSchema(responseJsonSchema) as { type: 'object'; additionalProperties: true }
  const skillPath = fileURLToPath(new URL('../skills/stardew/SKILL.md', import.meta.url))
  const skill = readFileSync(skillPath, 'utf8')
  const description = /^description: (.+)$/m.exec(skill)?.[1]
  if (!description) throw new Error('随包 skill 缺少 description。')
  ctx.skills.register({ name: 'stardew', description, source: 'bundled', provider: 'dsh-stardew', path: skillPath, content: skill.replace(/^---\n[\s\S]*?\n---\n/, ''), resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/stardew', import.meta.url)) } })
  const runner = new JevRunner({
    call: runCli, cwd: process.cwd(), enabled: config.jevEnabled ?? false,
    timeoutMs: config.jevTimeoutMs ?? 8000, minConfidence: config.jevMinConfidence ?? 0.35,
    key: async () => (await ctx.get('credentials')?.resolve(credentialRef('OPENROUTER_API_KEY')))?.value ?? process.env.OPENROUTER_API_KEY,
  })
  const planner = new StagePlanner(runner)
  ctx.effect(() => async () => { await planner.dispose(); await runner.dispose() }, 'stardew:runner')
  mountPanel(ctx, runner, planner)
  ctx.systemPrompt.section({ name: 'stardew:play', order: 10300, text: `使用中文处理星露谷任务。先读取 stardew skill。简单目标用 stardew_run_start 启动一次；复杂目标用 stardew_plan_start 传入用户总目标和首个阶段，Jev 自主观察、探索与执行。只按有意义的结果划分阶段，不拆成移动、选工具等逐动作指令。计划结束、受阻或待复核时证据自动回到本聊天；根据原总目标用 stardew_plan_next 接续，或 stardew_plan_finish 汇总，不能重开任务来重置预算。不轮询等待，不调用额外 CLI 操纵角色。启动后告知任务和 /stardew 面板入口。用户可在面板独立运行，手动暂停、继续或停止会结束自动阶段接续。缺水时 Jev 可自行寻找水源补水；默认只给需要水的作物浇水，只有用户明确要预浇空地才开启对应 policy。真实与模拟、游戏核验与模型判断必须区分。测试存档不是普通游玩的前提，不能修改存档来满足目标。能力缺口按实际记录报告。${config.jevEnabled ? 'Jev 已启用，游戏写操作由运行控制器统一执行。' : 'Jev 尚未启用；可使用原子工具或提示以 --jev 启动。'}` })
  const completion: ValueSchemaSpec = { type: 'object', additionalProperties: false, properties: {
    location: { type: 'string', description: '需要到达的地图内部名称。' },
    exploredTiles: { type: 'integer', description: '相比启动时新增的观察格数。' },
    cropId: { type: 'string', description: '作物产物 ID，与快照 crop 一致，例如防风草为 24。' },
    cropCount: { type: 'integer', description: '本次任务新种植的指定作物数量；与 cropId 一起填写。' },
    watered: { type: 'boolean', description: '要求本次新种植作物在播种当日被浇水。' },
    nextDay: { type: 'boolean', description: '要求游戏日期相对任务开始推进。' },
    wateredCrops: { type: 'integer', description: '本阶段实际从干到湿的作物格数（可包含已有作物），1–1000。' },
    refill: { type: 'boolean', description: '要求本阶段在水源补水，且水壶水量实际增加。' },
  } }
  const policy: ValueSchemaSpec = { type: 'object', additionalProperties: false, properties: {
    allowEmptySoilWatering: { type: 'boolean', description: '默认 false；只有用户明确要求预先浇空耕地时设为 true。' },
  } }
  const controls: { name: string; description: string; parameters: ParameterSchemaSpec }[] = [
    { name: 'start', description: '启动 Jev 自主游玩。只需调用一次，后续由控制器连续观察和执行；返回 runId 和运行面板入口。', parameters: {
      goal: { type: 'string', required: true, description: '用户目标原文，保留数量、物品及时间限制。' },
      radius: parameters.snapshot.radius,
      maxDecisions: { type: 'integer', description: '最多 Jev 请求次数，1–1000，默认 100。' },
      maxMinutes: { type: 'integer', description: '最多运行分钟数，1–120，默认 15。' },
      singleStep: { type: 'boolean', description: '执行一个动作后暂停，默认 false。' },
      completion: { ...completion, description: '可选完成判据，所有填写条件都需通过。未提供时模型申请结束会标为待复核。' },
      policy,
    } },
    { name: 'status', description: '按需读取自主游玩的状态、调用证据和最近结果；不调用模型。', parameters: {} },
    { name: 'pause', description: '暂停 Jev 控制器，等待在途请求和动作停稳。游戏时间仍遵循游戏自身设置。', parameters: {} },
    { name: 'resume', description: '继续已暂停或受阻的任务，重新观察后行动。更新目标会清除旧完成条件。', parameters: { goal: { type: 'string' }, singleStep: { type: 'boolean' } } },
    { name: 'stop', description: '停止自主游玩并等待动作停稳，保留本次游戏变化和记录。', parameters: {} },
  ]
  for (const control of controls) ctx.tools.register(defineTool({
    name: `stardew_run_${control.name}`, description: control.description, parameters: control.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('控制请求已取消。')
      if (['start', 'resume'].includes(control.name) && planner.active) throw new Error('阶段计划正在进行，请使用 plan_next；需要手动接管时先暂停或停止。')
      if (['pause', 'stop'].includes(control.name)) planner.manual(control.name === 'pause' ? 'paused' : 'stopped')
      control.name === 'start' ? runner.start(args as unknown as RunInput, exec.agent?.session.header.cwd ?? process.cwd())
        : control.name === 'resume' ? runner.resume(args.singleStep === true, args.goal as string | undefined)
        : control.name === 'pause' ? await runner.halt('paused')
        : control.name === 'stop' ? await runner.halt('stopped') : undefined
      const web = ctx.get('webServer') as { port: number } | undefined
      return JSON.parse(JSON.stringify({ ...planner.view(), panelUrl: web ? `http://127.0.0.1:${web.port}/stardew` : null }))
    },
    presentCall: args => ({ card: 'generic', title: `Jev · ${control.description}`, kind: control.name === 'status' ? 'read' : 'execute', rawInput: JSON.stringify(args) }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Jev · 自主游玩', content: result.content }),
  }))
  const stageParameters = { goal: controls[0].parameters.goal, radius: parameters.snapshot.radius, completion, policy }
  for (const spec of [
    { name: 'start', description: '启动由本聊天监督的阶段计划。大模型给总目标和首个阶段，Jev 连续自主执行；阶段结束自动回传证据。', parameters: {
      ...stageParameters, objective: { type: 'string', required: true, description: '用户总目标和约束原文，后续阶段必须围绕它。' },
      maxStages: { type: 'integer', description: '整个计划最多阶段数，默认 4，上限 12。' },
      maxDecisions: { type: 'integer', description: '各阶段合计 Jev 调用预算，默认 100，上限 1000。' },
      maxMinutes: { type: 'integer', description: '整个计划墙钟时限，包含模型规划等待，默认 15 分钟。' },
    } as ParameterSchemaSpec },
    { name: 'next', description: '根据自动回传的阶段证据继续同一总目标，共享剩余预算。需要原聊天和准确的阶段编号。', parameters: {
      ...stageParameters, planId: { type: 'string', required: true }, previousRunId: { type: 'string', required: true },
      rationale: { type: 'string', required: true, description: '依据前一阶段证据说明下一阶段目的，或受阻后的具体调整。' },
    } as ParameterSchemaSpec },
    { name: 'finish', description: '汇总本聊天的阶段计划，区分游戏核验与模型判断；不触发新游戏动作。', parameters: {
      planId: { type: 'string', required: true }, outcome: { type: 'string', enum: ['completed', 'blocked'], required: true }, summary: { type: 'string', required: true },
    } as ParameterSchemaSpec },
  ]) ctx.tools.register(defineTool({
    name: `stardew_plan_${spec.name}`, description: spec.description, parameters: spec.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.signal.aborted || !exec.agent) throw new Error('阶段计划需要从活动的 dsh 聊天调用。')
      const agent = exec.agent
      if (spec.name === 'start') {
        planner.start(args as unknown as PlanInput, { identity: agent, sessionId: String(agent.session.id), cwd: agent.session.header.cwd ?? process.cwd(), model: agent.options.model,
          notify: text => {
            const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'stardew', form: 'notice', summary: '星露谷阶段结果' } })
            if (agent.status === 'idle') agent.followup(message)
            else agent.inject(message)
          },
        })
        agent.ctx.effect(() => () => planner.detachOwner(agent), 'stardew:plan-owner')
      } else if (spec.name === 'next') planner.next(args as unknown as NextStage, agent)
      else planner.finish(String(args.planId), agent, args.outcome as 'completed' | 'blocked', String(args.summary))
      const web = ctx.get('webServer') as { port: number } | undefined
      return JSON.parse(JSON.stringify({ ...planner.view(), panelUrl: web ? `http://127.0.0.1:${web.port}/stardew` : null }))
    },
  }))
  for (const command of Object.keys(parameters) as Command[]) {
    if (config.jevEnabled && writes.has(command)) continue
    if (writes.has(command)) parameters[command].actionId = { type: 'string', description: '重试未知结果时复用原 actionId；省略时根据工具调用编号生成。' }
    ctx.tools.register(defineTool({
      name: `stardew_${command}`, description: descriptions[command], parameters: parameters[command],
      output: {
        schema: outputSchema,
        render: (_args, value) => [{ type: 'text', text: render(responseSchema.parse(value)) }],
        presentationMeta: (_args, value) => value,
      },
      async execute(args, exec) {
        if (command === 'stop') { planner.manual(); await runner.halt('stopped') }
        return runCli(command, args, exec.signal, exec.agent?.session.header.cwd ?? process.cwd(), String(exec.callId))
      },
      presentCall: args => ({ card: 'generic', title: descriptions[command], kind: command === 'snapshot' || command === 'status' ? 'read' : 'execute', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: `星露谷 · ${command}`, content: result.content }),
    }))
  }
}
