---
name: stardew
description: 当用户要求在星露谷里探索、种植、浇水、补水、回屋，或查看、暂停、继续农场任务时使用。通过 dsh 的 Jev 控制器自主游玩，按阶段规划并核对游戏证据，报告具体能力缺口。
---

# 星露谷自主游玩

先保留用户指定的物品、数量和时间限制。简单目标用 `stardew_run_start` 启动一次。复杂目标用 `stardew_plan_start` 给出用户总目标 `objective` 和首个阶段 `goal`；阶段结束后证据自动回到本聊天。控制器自主读取游戏、生成候选、调用 OpenRouter `~typesafe/jev-latest` 并持续执行。不要把目标改写成逐动作脚本。

返回实际 runId 和 panelUrl 后，告知用户可点击聊天右上角“农场小助手”或任务卡片的“查看农场”，在右侧查看和接管当前任务；panelUrl 是独立页面入口。不要让用户在面板重复启动同一个任务。面板也可独立输入目标、单步、暂停、继续和停止；不需要聊天模型配置。不要反复轮询或另外调用 CLI 操纵同一个角色。

## 控制接口

| 工具 | 参数与用途 |
| --- | --- |
| `stardew_run_start` | goal 必填；可选 radius（默认 8）、maxDecisions（默认 100）、maxMinutes（默认 15）、singleStep、completion、policy |
| `stardew_run_status` | 按需查看状态、实际模型、请求证据和动作记录 |
| `stardew_run_pause` | 取消在途推理／动作，等待停稳，保留任务 |
| `stardew_run_resume` | 继续原任务；可选新 goal、singleStep。更改目标会清除旧完成条件 |
| `stardew_run_stop` | 结束本次运行，保留游戏中已发生的变化 |
| `stardew_plan_start` | objective、goal 必填；可选 radius、completion、policy、maxStages（默认 4）、maxDecisions、maxMinutes |
| `stardew_plan_next` | planId、previousRunId、goal、rationale 必填；可选 radius、completion、policy；沿用总计划剩余预算 |
| `stardew_plan_finish` | planId、outcome（completed 或 blocked）、summary 必填；停稳后汇总，不触发新动作 |

先暂停再改目标。已发布的游玩任务独立于当前聊天回合；聊天停止按钮只停止聊天，停止游戏控制要使用专用工具或面板。暂停 Agent 不会暂停游戏时钟。

## 完成条件

所有填写的条件都要满足。仅按用户明确目标设置判据，不替换指定物品或擅自增加过夜要求；条件只定义结果，动作仍由 Jev 逐轮选择。没有明确判据时省略整个 completion，不传空对象。

| 字段 | 含义 |
| --- | --- |
| location | 到达的地图内部名称，例如 Farm、FarmHouse |
| exploredTiles | 相比本阶段第一次观察新增的观察格数，1–65536 |
| cropId + cropCount | 本阶段新种植的作物产物 ID 与数量（1–1000），两者同时填写；不是种子的物品 ID |
| watered | 本阶段新种作物在播种当日已浇水，必须同时指定 cropId、cropCount |
| wateredCrops | 本阶段实际从干到湿的作物格数（1–1000），可包含已有作物 |
| refill | true 表示要求观察到一次水壶水量增加，不等于必须补满 |
| nextDay | true 表示日期相比本阶段开始推进；仅在用户允许过夜时使用 |

用户说“种下 1 颗防风草并浇水，不要睡觉”：

```json
{"tool":"stardew_run_start","arguments":{"goal":"在当前农场种下 1 颗防风草并浇水。完成后停止，不要睡觉。","completion":{"cropId":"24","cropCount":1,"watered":true}}}
```

用户说“给 5 格现有作物浇水，水不够自己补”：

```json
{"tool":"stardew_run_start","arguments":{"goal":"给 5 格尚未浇水的现有作物浇水，水不够时寻找水源补水，不要睡觉。","completion":{"wateredCrops":5}}}
```

不把补水设为这个任务的强制条件，因为现有水量可能已够用。

自由目标可以省略 completion。Jev 提议结束时，状态为 `needs_review`；`completed` 才表示指定条件通过游戏证据核验。模型概率不等于任务成功率。`mode=mock` 明确代表模拟环境。

## 观察与恢复

复杂任务按有意义的结果拆阶段，例如“完成播种与浇水”“回屋过夜”，不要拆成选槽位、走到某格等动作列表。`maxStages` 默认 4，`maxDecisions` 默认 100 为全计划共享预算，`maxMinutes` 默认 15 为包括规划等待在内的墙钟时限。只启动当前阶段。

收到 `stardew` 插件回传后，依据总目标与阶段证据判断：需要继续时调用 `stardew_plan_next`，传入原 `planId`、`previousRunId`、下一阶段 `goal`、`rationale` 和本阶段的完成条件；结束时调用 `stardew_plan_finish`，汇总完成或阻塞的证据。不能用新的 start 绕过预算。手动控制、会话释放、存档切换和预算耗尽后不能自动接续。`model_completed` 是聊天模型对总目标的汇总判断，不能替代每个阶段的游戏核验。

默认只生成需要水的作物浇水候选，空耕地不参与。只有用户明确要求预浇空地，才设置 `policy.allowEmptySoilWatering=true`。水壶不足时 Jev 可以选择工具、靠近已观察水源并 `use` 补水；补水以实际水量增加验收。水源在视野外时可根据地标返回或自主探索。

阶段说明必须保留总目标中的数量、物品与时间限制。用户明确要求“种下 5 颗防风草并浇水，然后回屋睡觉”时，首阶段为：

```json
{"tool":"stardew_plan_start","arguments":{"objective":"种下 5 颗防风草并浇水，然后回屋睡觉。","goal":"先种下 5 颗防风草并在当天浇水，缺水自行补水。本阶段不要睡觉。","completion":{"cropId":"24","cropCount":5,"watered":true}}}
```

只有前一阶段的播种与浇水证据充分时，才以原 planId、previousRunId 接续“回屋睡觉”，完成条件为 `{ "location": "FarmHouse", "nextDay": true }`。每个阶段的播种、浇水等计数重新开始，不能把上一阶段的 5 颗作物再计为本阶段新种植。

控制器通过地块、出口、对象、物品和菜单生成现场候选，记住已观察区域及近期结果。它会刷新引用、排除相同现场失败、检测重复往返，并在请求或时间预算耗尽时停下。

`blocked` 时按返回原因处理：连接或存档问题先检查游戏；凭据问题检查 OPENROUTER_API_KEY；不支持的菜单、购买或容器操作按记录报告具体能力缺口。不要反复启动相同失败。用户存档不能作为可丢弃测试数据，不修改存档来满足游玩目标。

`stardew_snapshot`、`stardew_doctor`、`stardew_status` 用于按需排障。`stardew_screenshot` 可以保存新的 PNG 路径。Jev 关闭时才使用普通原子写工具；独立 CLI 保留同一组基础能力。

当前 Mod 支持移动、选择、耕地、种子播种、浇水、水壶补水、斧头／镐、场景交互和对话选项。完整农务候选需要新版 Mod 返回 diggable、tool、category、needsWater、refillable 和 waterCapacity 字段。安装 Mod 更新需先正常保存并退出游戏；不能仅重启 dsh 就声称游戏端已更新。

## 农场日记式汇报

使用简短、温和的中文，围绕“今天的农活、田地、背包、农舍”叙述，保留准确状态。不要扮演游戏 NPC，也不编造天气、收获、奖励或游戏对白。

- 启动：说明已交给 Jev 的目标，附实际 runId 和面板入口；不提前宣告完成。
- 完成：先说明真实游戏或模拟农场，再给已核验数量、浇水和日期等与目标相关的证据。例如“模拟农场：1 颗防风草已种下并浇水，完成条件已核验。”
- 待复核：明确“Jev 建议收工，但目标尚待复核”，列出缺少的证据。
- 受阻：说清卡在哪里、保留了哪些进展，以及需要用户处理的一件事；错误码和日志路径按需附后。

日期、体力、物品和数量都来自工具返回。不要把内部 JSON 整段复述给用户，不将模型概率写成成功率，不将自动化测试或模拟农场结果描述为真实游戏通过。

## 更新与连接

此 skill 随 dsh-stardew 插件注册，不需要单独安装。源码更新后运行 `pnpm build:ts` 并重启 dsh，才会加载新的 skill 与浏览器插件；Mod 改动还需正常退出游戏后重新安装。浏览器需要重新登录时，在项目目录运行 `pnpm open`；`pnpm open --print` 输出本机有效登录链接，不要把带 token 的链接写入聊天记录、文档或截图。
