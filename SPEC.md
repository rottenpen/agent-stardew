# agent-stardew 与 dsh 插件 SPEC

状态：已确认，进入实现。调研日期：2026-09-16。参考项目已静态核查，尚未在游戏中验证。

交付一个 monorepo：`agent-stardew` 提供独立的游戏操作 CLI，`dsh-stardew` 将同一组操作注册成 dsh 工具。SMAPI Mod 随仓库维护，负责读取游戏状态和执行动作。用户在 dsh 中描述目标，由 dsh 的模型持续调用工具完成游戏任务。

## 1. 目标与验收

首版针对本机 macOS、桌面版星露谷、单人存档和单个运行中的游戏实例。以正常游戏动作完成移动、交互、耕地、播种和浇水；动作遵守当前存档的物品、体力、距离和碰撞约束。

### 用户故事一：独立使用 CLI

作为操作者，我可以从终端查看当前场景，并通过明确的命令驱动角色。

- [ ] `doctor` 能区分依赖缺失、Mod 未连接、协议不兼容和存档未加载。
- [ ] `snapshot` 输出紧凑场景信息，`--json` 输出稳定的结构化结果。
- [ ] 可移动到地图格子或目标附近，选择物品，使用工具和交互。
- [ ] 动作结束后能确认实际结果；阻挡、材料不足和取消有可区分的结果。

### 用户故事二：从 dsh 操作游戏

作为 dsh 用户，我安装插件后直接描述游戏目标，模型可以发现并调用游戏工具。

- [ ] 构建后的插件可用 `dsh plugin --profile <name> add <package>` 安装。
- [ ] 工具参数和返回值有 schema，可用于普通工具调用和 dsh 的 PTC 调用。
- [ ] CLI 与 dsh 工具使用相同动作语义、错误码和结果字段。
- [ ] 用户取消工具调用时，取消能传递到游戏动作。
- [ ] dsh 的日志可以还原模型看见的观察和动作结果。

### 用户故事三：完成一次游戏任务

作为操作者，我可以让 dsh 从准备好的初始存档完成“种下 5 颗防风草、逐一浇水、回屋睡觉”。

- [ ] 起点、工具、种子、可用土地和体力在测试存档中确定。
- [ ] 游戏状态证明 5 颗作物已播种和浇水，睡觉后日期推进。
- [ ] 从同一备份恢复并运行 5 次，至少 4 次完成；报告实际次数和模型调用量。
- [ ] 失败时保存动作、错误、前后快照和必要截图。

## 2. 现有项目做到了什么

本节的“已有”表示代码或文档存在对应实现，不代表已通过本机实测。核查固定在以下提交：

- StarDojo：[`f36b55a`](https://github.com/WeihaoTan/StarDojo/tree/f36b55a6be5678692daab14773554b46a31b90a3)。
- stardew-mcp：[`3ca54bb`](https://github.com/Hunter-Thompson/stardew-mcp/tree/3ca54bbfc1d446eeb06d822a74c92cd14df82b93)。

| 能力 | StarDojo | stardew-mcp |
|---|---|---|
| 角色与世界观察 | 体力、金钱、时间、日期、位置、背包、手持物品；地图周边、作物、NPC、建筑、动物、菜单 | 角色、时间、天气、背包；附近对象、地形、NPC、怪物、建筑、动物、出口；任务、关系、技能；ASCII 地图 |
| 移动 | Mod 有绝对与相对坐标移动、单步移动和寻路；Python `move` 实际发送相对移动 | A* 寻路；移动结束回调；卡住重算路径；朝向、停止、进门 |
| 工具与农务 | 选物品、朝向使用工具、交互；组合成清理、耕地、播种、浇水、采收 | 单次、重复和蓄力使用工具；选择物品、放置、食用；Go Agent 有查找和清理目标的组合工具 |
| 菜单与经济 | 选择菜单选项，购买/出售相关选项，箱子取放，制作，装备附件 | Mod 分发器有商店、购买、出售、制作、出货、送礼、读信等处理器；Go Agent 的普通工具列表未完整开放这些能力 |
| 动物与战斗 | 有相关状态、交互和任务判定器；任务种类不能直接等同于动作成功率 | Mod 有抚摸、挤奶、剪毛、收集产品、攻击、装备武器和炸弹处理器 |
| 钓鱼 | 工具操作和附件接口；本次核查未验证独立完整的自动钓鱼控制器 | 有抛竿、咬钩后收线入口；收线实现进入小游戏，不能据此认定可以自动完成小游戏 |
| 截图与时间 | 截图观察、视频输出；pause/resume API；载入存档和回到标题页 | 主要提供结构化状态和 ASCII 地图；有作弊时间控制；未见同等截图输出接口 |
| Agent 层 | Python Agent、模型适配、观察/规划/反思等模块；有原子与组合技能 | Go 程序通过 Copilot SDK 创建会话，自带目标循环；代码中模型名为 `gpt-4.1`，与 README 的 Claude 描述有差异 |
| 评测 | 农务、制作、探索、战斗、社交任务配置及独立判定器；串行与并行运行入口 | 未见同等任务评测套件 |
| 游戏通信 | TCP 文本命令；观察使用内存映射文件等传输 | WebSocket JSON；Mod 主线程处理排队动作并返回结果 |

### 影响选型的具体限制

1. **StarDojo 的坐标约定需要统一。** 动作文档描述 `move(x,y)` 为目标坐标，但 Python `ActionProxy.move` 发送 `move_relative`。新 CLI 将所有 `--tile x y` 明确定义为当前地图的绝对格子坐标。
2. **StarDojo 的任务判定在单独的 evaluator 中。** 当前 `step()` 返回的 reward 为 0、terminated/truncated 为 false；不能把该返回值直接作为任务成功判断。
3. **StarDojo 的构建和传输需要适配。** 项目文件包含本地游戏 DLL 路径；`navigate` 在文档中注明默认禁用。应逐项验证需要的 Mod 能力和平台行为。
4. **stardew-mcp 的 Agent 可调用能力少于 Mod 动作集合。** Go 侧普通工具有 12 个，其他不少动作只存在于 Mod 分发器。新增 CLI 必须根据真实处理器与结果设计接口。
5. **stardew-mcp 当前 Go 程序不是可直接接入任意客户端的标准 MCP 服务。** 本次核查到的是 WebSocket 客户端和 Copilot SDK 工具注册，未找到标准 MCP 服务入口。
6. **stardew-mcp 的当前自主循环偏向作弊操作。** 默认目标和循环提示包含清场、瞬间耕地、种植、生长与采收指令；任务完成还依赖模型文本。它可以作为观察和控制设计参考，完成判据需由游戏状态提供。

来源：StarDojo 的 [动作 API](https://github.com/WeihaoTan/StarDojo/blob/f36b55a6be5678692daab14773554b46a31b90a3/StardojoMod/actions/ActionsAPI.cs)、[Python 代理](https://github.com/WeihaoTan/StarDojo/blob/f36b55a6be5678692daab14773554b46a31b90a3/env/actions.py)、[环境 step](https://github.com/WeihaoTan/StarDojo/blob/f36b55a6be5678692daab14773554b46a31b90a3/env/stardew_env.py)、[观察文档](https://github.com/WeihaoTan/StarDojo/blob/f36b55a6be5678692daab14773554b46a31b90a3/docs/docs_src/observation_space.md)；stardew-mcp 的 [Mod 动作](https://github.com/Hunter-Thompson/stardew-mcp/blob/3ca54bbfc1d446eeb06d822a74c92cd14df82b93/mod/StardewMCP/CommandExecutor.cs)、[状态序列化](https://github.com/Hunter-Thompson/stardew-mcp/blob/3ca54bbfc1d446eeb06d822a74c92cd14df82b93/mod/StardewMCP/GameStateSerializer.cs)、[Agent 工具与循环](https://github.com/Hunter-Thompson/stardew-mcp/blob/3ca54bbfc1d446eeb06d822a74c92cd14df82b93/mcp-server/copilot_agent.go)、[Go 入口](https://github.com/Hunter-Thompson/stardew-mcp/blob/3ca54bbfc1d446eeb06d822a74c92cd14df82b93/mcp-server/main.go)。

### 采用方式

新仓库自行维护 CLI、协议和 dsh 插件。Mod 的观察、菜单和动作实现优先评估 StarDojo 中适合抽取的部分，逐项移植和验证，并保留其 MIT 许可与归属说明。stardew-mcp 在所查提交中没有 LICENSE 文件，因此当前方案仅参考功能与通信设计。

## 3. Monorepo 结构

建议仓库名和命令名为 `agent-stardew`；下列名称是待实现的设计名称。

```text
agent-stardew/
├── packages/
│   ├── cli/                 # agent-stardew：命令解析、通信、文本/JSON 输出
│   ├── dsh-plugin/          # dsh-stardew：Cordis 工具、配置、bundle patch
│   └── protocol/            # 命令/结果 schema、错误码、协议样例
├── mods/
│   └── AgentStardew/        # C# SMAPI Mod：观察、引用、寻路、动作执行
├── tests/
│   ├── integration/         # 协议、CLI 与插件联调
│   └── game/                # 测试存档说明、实机验收记录
├── docs/
│   ├── cli.md
│   └── dsh.md
├── SPEC.md
└── pnpm-workspace.yaml
```

TypeScript 部分使用 pnpm workspace；Mod 使用 .NET 项目，由根级构建命令统一调度。CLI 的游戏操作由 Mod 执行，dsh 负责目标规划和模型调用。

调用关系：

```text
用户在 dsh 中描述目标
  → dsh 的模型选择 stardew_* 工具
  → dsh-stardew 以 argv 启动 agent-stardew，并读取 --json 结果
  → CLI 通过本机 WebSocket 连接 AgentStardew Mod
  → Mod 在游戏主线程读取状态、执行动作、返回终态
  → CLI 与插件返回可验证的结果，dsh 决定下一步
```

Mod 常驻并持有快照引用和动作状态；CLI 每次调用连接到同一实例。插件通过依赖解析定位随包交付的 CLI 入口，也允许配置显式路径，避免依赖交互式终端的全局 PATH。

## 4. CLI 的操作体验

借鉴 [agent-browser](https://agent-browser.dev/) 的紧凑 snapshot、目标引用、结构化输出和明确命令。星露谷没有浏览器的可访问性树，快照由 Mod 构建。

以下均为拟定接口示例；坐标、引用和槽位是示例值。

```sh
agent-stardew doctor --json
agent-stardew snapshot
agent-stardew snapshot --json
agent-stardew move --tile 12 8
agent-stardew move --near @s17:e3
agent-stardew select --slot 3
agent-stardew use @s17:e3
agent-stardew interact @s17:e5
agent-stardew menu choose @s18:m1
agent-stardew screenshot --output ./farm.png
agent-stardew status --json
agent-stardew stop --json
```

紧凑 snapshot 示例：

```text
snapshot=s17  location=Farm  day=Spring 1  time=08:20
player=(12,8)  energy=245/270  selected=Hoe

@s17:e1  可耕地 (13,8)
@s17:e3  防风草 (14,8) 未浇水
@s17:e5  农舍入口 (10,6)

inventory: slot=0 Hoe; slot=3 Watering Can; slot=4 Parsnip Seeds x5
```

槽位索引统一从 0 开始；物品内部 ID 与显示名称分开，防止语言设置影响动作选择。`move --near` 寻找可交互的相邻位置；`use` 和 `interact` 校验距离、朝向、工具及目标状态。

### 快照与引用

- 引用绑定游戏实例、存档加载代次、地图、快照和目标身份。
- 发起动作时重新验证目标；切换存档、场景不匹配或目标已消失时返回 `STALE_REF`。
- 时间推进、角色转向等无关变化不会单独导致目标引用失效。
- NPC 移动时解析其当前位置；指定地块的动作保持地块身份。
- 快照明确观察范围，并标记截断；远处未观察到的对象不能被当作不存在。

### 结果与失败

`--json` 在 stdout 输出一个完整 JSON；诊断日志写 stderr。默认文本只保留 Agent 判断下一步需要的事实。

```json
{
  "protocolVersion": 1,
  "requestId": "req-17",
  "actionId": "act-42",
  "status": "completed",
  "result": {
    "location": "Farm",
    "position": { "x": 13, "y": 8 },
    "arrived": true
  }
}
```

`status` 的终态为 `completed`、`failed`、`cancelled`；查询活动动作时可返回 `running`。失败携带 `error.code`、`message`、`retryable` 和必要的当前状态。

错误码至少覆盖 `NOT_CONNECTED`、`INCOMPATIBLE_PROTOCOL`、`NO_SAVE_LOADED`、`STALE_REF`、`BUSY`、`PATH_BLOCKED`、`OUT_OF_REACH`、`INSUFFICIENT_RESOURCE`、`MENU_MISMATCH`、`TIMEOUT`、`CANCELLED`。CLI 退出码约定为成功 0、参数错误 2、其他失败 1、用户取消 130；具体原因以 JSON 为准。

### 动作完成与取消

- 游戏内同一时刻执行一个改变角色或世界状态的动作；其他写操作返回 `BUSY`。状态查询和停止可并行处理。
- 请求有 ID，Mod 在当前会话内保留有界的执行结果；同一动作 ID 重试不重复播种或消费物品。
- CLI 等待真正的终态。移动必须到达或报告失败；播种、浇水等必须检查对应状态变化。
- Mod 主线程执行动作和采集快照；网络线程仅负责协议与队列。
- 中止信号沿 dsh → CLI → Mod 传递。断连和超时触发停止后续自动动作并释放模拟输入；已经发生的游戏结果保留并在下次观察中报告。
- Mod 有独立的动作时限和连接丢失处理，保证 CLI 被强制结束后角色不会继续无限移动。
- 首版游戏时间按当前游戏规则推进，快照返回游戏时刻。需要在实测中记录模型等待消耗的游戏时间，作为连续游玩的验收数据。

## 5. dsh 插件接入

本机 `dsh` 指向本地 DeepSeek Harness，根包版本为 `0.1.5-rc.1`；核查时仓库 HEAD 为 `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`。实现和测试以本机实际 API 为基线，并锁定依赖版本。

插件使用当前官方形态：

- 导出 Cordis 的 `name`、`inject`、`apply(ctx)`。
- 使用 `defineTool` 与 `ctx.tools.register` 注册带参数和结果 schema 的工具。
- 工具 `execute` 返回规范 JSON 值；`output.render` 输出紧凑的模型可见文本。
- 通过 `ctx.subprocess` 使用独立 argv 调用 CLI，处理有界 stdout/stderr 和 `exec.signal`。
- 提供中文的通用工具调用/结果展示；持久化元数据只包含重放需要的游戏事实。
- `package.json` 声明 `dsh.bundle.patch`，patch 挂载插件。

拟注册的工具：`stardew_snapshot`、`stardew_move`、`stardew_select`、`stardew_use`、`stardew_interact`、`stardew_menu`、`stardew_screenshot`、`stardew_status`、`stardew_stop`。

插件配置包括 Mod endpoint、CLI 入口、单次动作时限和输出上限。对游戏的写动作遵循上述单动作约束，多次工具调用按依赖顺序执行。连接地址首版限制为本机回环。

安装与启动体验示例，需在实现和构建完成后于新仓库根目录执行：

```sh
dsh plugin --profile web add ./packages/dsh-plugin
dsh --profile web
```

在 dsh 会话中输入：

> 查看当前农场，种下 5 颗防风草并浇水，然后回屋睡觉。每一步根据游戏状态检查结果。

插件包通过依赖交付 CLI；SMAPI Mod 作为独立 zip 发布到游戏 `Mods` 目录。根目录的 `pnpm build` 构建 TS 包与 Mod，发布包的安装验证在 monorepo 之外执行。

接入依据为本机 dsh 的 `docs/user/develop/basic/publish.zh.md`、`docs/cookbook/adding-a-tool.zh.md` 和 `packages/subprocess/subprocess/README.zh.md`。公开仓库：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 6. 实现顺序与测试

| 阶段 | 交付 | 验证方式 |
|---|---|---|
| 1：观察打通 | 协议握手、Mod 状态读取、CLI doctor/snapshot、dsh snapshot 工具 | 从 dsh 读取真实位置、背包、体力和当前菜单，和游戏画面核对 |
| 2：动作打通 | 寻路、选择工具、使用、交互、菜单选项、停止、引用验证 | 实机移动、一次耕地、播种、浇水；验证阻挡与取消 |
| 3：完成任务 | 完整工具组、截图、任务说明和重复运行记录 | 5 次播种浇水睡觉任务；统计成功率、调用量、游戏时间和失败原因 |
| 4：安装验收 | CLI 包、dsh bundle、Mod zip、使用文档 | 在仓库外安装 CLI 和插件；确认依赖解析与 profile 加载成功 |

有针对性的自动检查：协议版本和样例一致性；CLI 输出及退出码；过期引用；重复动作 ID；并发 BUSY；超时/断连/取消；dsh 结果 schema 与生命周期。游戏内动作语义用真实游戏验证，测试记录区分模拟服务验证和实机通过。

后续能力可按任务需求加入商店、箱子、制作、NPC 对话/送礼、采矿、动物照料和钓鱼。每项能力同时补充观察字段、动作完成判据和实机用例。

## 7. 本机准备情况与依赖

已确认：

- `dsh`、`agent-browser`、Node.js 和 GitHub CLI 可运行。
- 默认 Steam 路径中存在游戏 DLL 与 SMAPI DLL。
- 游戏 runtimeconfig 声明 `net6.0`，包含 .NET runtime `6.0.32`。
- 默认 Mod 目录可见 `ConsoleCommands` 与 `SaveBackup` 的 manifest。

进入构建前需要完成：

- 定位或安装兼容的 .NET SDK；当前 shell 的 PATH 中没有 `dotnet`。
- 从实际启动日志锁定游戏与 SMAPI 版本，验证所选 SDK 可以构建目标 Mod。
- 手动确认游戏和 SMAPI 可以启动，准备测试存档及备份。
- 确认 dsh 的模型调用可用；本轮没有读取凭据或发起付费模型测试。

## 8. 风险与边界

| 情况 | 对实现的影响 | 处理方式 |
|---|---|---|
| 现有 Mod 源码与本机版本不兼容 | 编译成功也可能无法运行 | 先完成最小 Mod 的读取和动作实测，再迁移更多能力 |
| dsh API 处于预稳定版本 | 工具、输出或 bundle 约定可能变化 | 锁定经过测试的版本，并保留插件安装烟测 |
| 模型基于旧快照决策 | 点击错误目标或使用已消失物品 | 游戏端重新验证引用和动作前提 |
| 模型等待期间游戏推进 | 错过营业时间或体力/日程规划失效 | 显式提供游戏时刻，首版测量任务耗时；根据结果决定时间控制需求 |
| 菜单、过场或睡觉切换状态 | 操作失效或完成判定提前 | 返回明确的交互状态，等待对应事件和稳定快照 |
| 多个 Agent 同时控制一个角色 | 动作互相覆盖 | 游戏实例统一串行写操作，冲突调用返回 BUSY |

