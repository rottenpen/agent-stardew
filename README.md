# agent-stardew

面向 Agent 的星露谷操作工具。通过独立 CLI 与 dsh 插件，让 Agent 读取游戏状态并驱动角色完成任务。

## 组成

- `packages/cli`：`agent-stardew` 命令行工具。
- `packages/dsh-plugin`：`dsh-stardew` Cordis 插件。
- `packages/protocol`：命令、结果 schema 和错误码。
- `mods/AgentStardew`：游戏内的 SMAPI Mod。

## 开发状态

项目已初始化，功能开发以 [SPEC.md](SPEC.md) 为准。安装方式与验证结果随实现补充。
