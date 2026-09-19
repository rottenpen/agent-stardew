# M0 开发验证记录

更新日期：2026-09-19。当前交付 Jev 自主控制器与 dsh 同源运行面板。完整真实游戏自主农务验收尚未达成。

## 2026-09-19 Skill 与农场面板

| 范围 | 结果 |
| --- | --- |
| `pnpm check` | 类型检查、构建与 19 项集成测试通过；游戏与模型为替身 |
| `pnpm test:dsh` | 6 项通过；新增随包 skill 正文、工具名称和 3 个 JSON 调用示例的真实注册器检查，不调用真实模型 |
| `pnpm test:login` | 3 项通过；使用当前 dsh 的真实鉴权服务，检查登录、凭据校验与入口恢复 |
| `pnpm test:mod` | 21 项 C# 调度、交互证据和协议检查通过，不包含真实游戏动作 |
| `pnpm test:package` | 三个 tarball 隔离安装通过，包含 skill、面板和图片；Mod 编译零警告、零错误，未安装至游戏 |
| 浏览器 | Playwright 验证开始、暂停、继续、停止、受阻、完成和断线恢复；1360、740、390、320 宽度无横向溢出；日历、体力、槽位与模拟观察一致，canvas 非空、图片加载正常 |

README 预览来自本项目面板的浏览器模拟数据。原始截图与检查记录位于 `work/ui-preview/`；发行包验证位于 `work/tests/package-GxP8jX/`。本轮未调用真实模型、操作游戏或修改存档。skill 的模型执行质量与完整真实游戏农务任务仍需单独验收。

## 2026-09-18 农务资源与阶段交接

| 范围 | 结果 |
| --- | --- |
| `pnpm check` | 19 项通过；模型替身与模拟农场，覆盖空水壶补水后播种浇水、作物筛选、共享预算、阶段归属与手动暂停 |
| `pnpm test:dsh` | 5 项通过；真实 dsh 注册器与 CLI 子进程，确认 `createUserMessage` 的 plugin 来源、空闲原会话 followup 回传与过期接续拒绝；会话接收方和游戏为替身 |
| `pnpm build:mod` | 针对本机游戏程序集编译，零警告、零错误；补水走原生工具使用入口并检查水量增加 |
| 面板脚本 | JavaScript 语法检查通过；新增阶段状态、预浇空地选项、补水和浇水格数条件 |
| 发行包 | `pnpm test:package` 隔离安装通过，检查运行时依赖、类型声明、随包 skill 与运行面板；证据位于 `work/tests/package-hgmlyj/` |

此轮未进行真实游戏或真实大模型阶段规划测试，未安装新 Mod 或重启用户的运行服务。后续真机验证需先保存退出游戏、结束旧服务，再执行 `pnpm start --jev`。

## 2026-09-18 Jev 自主循环与运行面板

| 范围 | 结果 |
| --- | --- |
| 类型、构建与集成 | `pnpm check` 通过，15 项测试通过；包含一次启动连续 20 次决策、预算终止、迟到响应丢弃、动作取消与完成证据校验。模型和游戏均为替身／mock |
| dsh 实际运行时 | `pnpm test:dsh` 4 项通过；使用真实注册器、构建产物与 CLI 子进程，模型响应及游戏端为模拟 |
| Mod 编译 | 新增 diggable、tool、category 观察字段；针对本机游戏编译，零警告、零错误 |
| 运行面板 | 本机 dsh `/stardew` 返回 HTTP 200，浏览器能读取目标、预算、开始／单步／暂停／继续／停止和概率、地图、日志区域 |
| 真实 Jev + 模拟农场 | 一次启动，5 次真实 Jev 请求、5 个动作，完成新种植 1 颗防风草并浇水；控制循环无聊天模型调用 |

真实模型返回 `typesafe/jev-1.13-20260917`。动作顺序由模型选择：耕地、选择防风草种子、播种、选择浇水壶、浇水。完成状态为 `completed / VERIFIED`，环境明确为 `mode=mock`。各次耗时为 4384、825、607、488、566 ms；这些数据仅代表这次本机请求。

证据目录：`work/runs/jev-a74a934d-6b44-4efc-993d-b40274b3421e/`。首个请求 ID 为 `gen-dec-1789712050-0ynyzOEue17pfDBRAIQ3`，最后请求为 `gen-dec-1789712056-dGQlzMdb75KOqEWIVlv6`。`events.jsonl` 保存观察、候选、实际模型回答与游戏结果，`status.json` 保存完成条件和播种浇水证据。

这次模型烟测未操作真实存档。新 Mod 已备份安装并通过 SMAPI 启动日志确认加载，真实任务仍需用户加载单人存档后执行。运行面板接入的是本机真实游戏 endpoint，模拟测试记录不混入该运行。

## 2026-09-17 基础检查

| 范围 | 方法 | 结果 |
|---|---|---|
| 类型与构建 | `pnpm check` 中的 TypeScript 检查、ESM 构建和类型声明生成 | 通过 |
| 协议、CLI、模拟流程 | 9 项测试：握手、边界参数、并发、重试、取消、超时、引用、doctor，以及五块播种浇水和睡觉 | 9/9 通过；游戏端为 mock |
| dsh 运行时 | `pnpm test:dsh`：真实 dsh 注册器和 subprocess，调用构建后的 CLI；模拟游戏端 | 2/2 通过；未调用模型 |
| C# 调度与网络 | `pnpm test:mod`：使用真实调度器、协议类及 BridgeServer | 17 项断言通过；包含交互完成信号，不包含游戏动作 |
| Mod 编译 | .NET SDK 6.0.428，针对 Stardew Valley 1.6.15 和 SMAPI 4.5.2 | 零警告、零错误 |
| 开发启动 | 首次及重复 `pnpm run setup --mock`、`pnpm dev --mock`、`pnpm run doctor --mock` | 通过；独立 Web UI 可返回 HTTP 200 |
| 发行包 | `pnpm test:package` 从三个 tarball 在隔离依赖目录安装 | 通过；依赖闭包、CLI 入口、类型声明及 skill 存在 |

发行包与 dsh 构建测试使用清理了 `NODE_OPTIONS` 的子进程，避免宿主预加载器将包导入重新指向 TypeScript 源码。它们不会从另一个 dsh 源码仓库加载实现。GitHub Actions 已配置这些不依赖游戏的检查，本次未触发远程 CI。

## 真实游戏验证

使用 `work/game-validation/` 中隔离的配置、Mods 和专用存档运行 Stardew Valley 1.6.15 build 24356、SMAPI 4.5.2 与 Agent Stardew 0.1.0。关闭 VSync 和失焦暂停后，桥接可稳定处理真实请求。验证未使用或覆盖用户存档。

专用存档为 `AgentTest / AgentFarm`。干净基线位于 `work/game-fixtures/m0-parsnip/baseline/AgentFarm_449313257/`：

- 主存档 SHA-256：`8150cc35e84242a417532d591cc757702af3c5e72eff07de658969f278a729b9`。
- `SaveGameInfo` SHA-256：`8dc1394a9e152ba1733a13b9856f26d21d20990555606a0e3da3ea3ad0553b15`。

已由真实游戏状态确认：

- `snapshot` 返回当前地图、日期、时间、位置、体力、背包和附近实体。
- `screenshot` 保存当前游戏画面。
- `move` 在农舍内从 `(9,9)` 到 `(4,7)`，并在农场完成多次相邻格移动。
- `menu choose` 可推进真实对话菜单。
- 使用锄头在农场 `(63..67,18)` 连续耕出 5 格，快照均为 `tilled=true`，体力从 270 降到 260。
- 修复后在 `(63..67,18)` 五格播种并浇水，快照均显示 `crop="24"`、`watered=true`；种子从 15 减到 10，水量从 40 减到 35，体力从 270 降到 250。

本轮真实游戏验证同时暴露了三个动作问题：

- 礼盒交互已经领取种子并打开对话，但旧实现只检查地图或菜单对象引用，错误返回 `UNSUPPORTED`。当前实现同时检查菜单签名、背包和目标存在性变化，并补充了 C# 断言。
- 农舍出口坐标为地图边界外一格 `(3,12)`，旧寻路在执行前错误拒绝。当前实现允许已观察到的原生 `Warp` 目标越过一格边界。
- 旧移动结束时调用 `IInputHelper.Suppress`，其真实语义是屏蔽按键而非释放按键，导致后续移动被残留输入状态干扰。当前实现按 SMAPI 4.5.2 接口约定逐 tick 调用 `Press`，停止时不再调用 `Suppress`。

2026-09-17 农务复测使用的 Mod SHA-256 为 `25163ea769f83e3d1f9e0248a127c59b1c9a5254d68e333fc8d0791a3991eb27`，交互、农舍出口、移动停止和五格播种浇水已有实机证据；过夜及完整自主任务仍未通过验收。记录位于 `work/runs/m0-fixed-real-20260917/`，睡前状态为 `pre-sleep-final-snapshot.json`。这些操作由人工编排 CLI，不能计入 dsh 模型成功率。

本地原始证据位于忽略的 `work/`：

- `check.log`、`dsh-test.log`、`mod-test.log`、`mod-build.log`。
- `setup-mock.log`、`setup-repeat.log`、`package-test.log`。
- `runs/game-title-smoke/`：真实请求结果。
- `game-smoke/sample.txt`：渲染停滞时的进程采样。
- `runs/m0-build-evidence.json`：当前构建文件及实机尝试文件的哈希。
- `runs/m0-manual-cli-20260917/`：真实快照、动作响应和截图。
- `runs/m0-fix-20260917/`：修复后的自动检查、C# 测试和 Mod 编译日志。

## 剩余验收

使用专用基线验证当前构建的农舍门观察、进出场景和睡觉日期推进；再从同一基线运行 5 次 Jev 自主任务，至少 4 次由游戏状态证明成功，并记录 Jev 用量及额外模型介入、游戏时间消耗、失败前后快照和干预次数。

M0 达标后，再实现开发任务委派、固定候选验证、版本启用、任务恢复和跨会话能力复用。桌面安装包以及普通用户自动准备工具链仍属后续阶段。
