# 参与贡献

感谢你参与 agent-stardew。项目接受错误修复、原子技能、基础动作、观察字段、控制器、界面、测试和文档改进。

提交代码即表示你同意按仓库的 [MIT License](LICENSE) 授权贡献内容。项目不接收游戏本体、游戏资源、用户存档、凭据或包含个人路径的完整运行记录。

## 开始开发

基础开发只需要 Node.js 22+ 和仓库指定的 pnpm，不需要安装游戏、配置模型或提供 API Key：

```sh
git clone https://github.com/rottenpen/agent-stardew.git
cd agent-stardew
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

需要调试 dsh 集成时执行：

```sh
pnpm run setup --mock
pnpm dev --mock
pnpm test:dsh
```

修改 SMAPI Mod 时还需要 .NET 6 SDK。只有构建真实 Mod 或连接游戏时才需要 Stardew Valley 与 SMAPI，具体环境见 [README](README.md) 和[研发与贡献体验](docs/developer-experience.md)。

## 选择修改入口

| 贡献目标 | 主要入口 | 最小验证 |
|---|---|---|
| 原子技能、前提、操作顺序或失败恢复 | `packages/dsh-plugin/src/agent/skills.ts` | `pnpm check` |
| Jev 控制循环、记忆、计划或生命周期 | `packages/dsh-plugin/src/agent/` | `pnpm check`、`pnpm test:dsh` |
| dsh 工具说明和聊天使用方式 | `packages/dsh-plugin/skills/stardew/SKILL.md`、`packages/dsh-plugin/src/index.ts` | `pnpm check`、`pnpm test:dsh` |
| 新观察字段或基础动作 | `packages/protocol`、`packages/cli`、`mods/AgentStardew`、mock 与测试 | `pnpm check`、`pnpm test:mod` |
| 运行面板 | `packages/dsh-plugin/src/client/`、`packages/dsh-plugin/ui/` | `pnpm check`，PR 附截图 |
| 安装、构建或发行 | `scripts/`、包配置 | 相关检查和 `pnpm test:package` |

新增基础动作应在一个 PR 中完成共享协议、CLI 映射、Mod 实现、模拟服务和自动化测试，避免主分支出现只能由部分组件识别的动作。

## 协议和游戏行为

`packages/protocol` 是 TypeScript、CLI、dsh 插件、模拟服务和 SMAPI Mod 之间的契约来源。

- 新增向后兼容的可选观察字段时，通常不升级 `PROTOCOL_VERSION`。
- 删除字段、改变字段含义、修改命令参数或改变既有结果语义时，必须升级 `PROTOCOL_VERSION`。
- 协议变更必须同步 TypeScript schema、C# 协议模型、mock、成功与失败测试以及相关文档。
- 写操作必须经过游戏公开行为执行并在操作后观察核验，不通过直接修改存档或游戏状态满足目标。
- 超时、取消、过期引用和结果不确定等路径需要保留现有的动作隔离与幂等约束。

## 测试和证据

提交 PR 前至少运行与你的改动对应的检查：

| 命令 | 范围 |
|---|---|
| `pnpm check` | 类型检查、TypeScript 构建、协议、CLI、控制器和 mock 集成测试 |
| `pnpm test:dsh` | 实际 dsh 工具注册、构建产物、子进程调用与取消；不调用模型 |
| `pnpm test:mod` | C# 调度、协议与网络队列；不连接游戏 |
| `pnpm test:package` | 从 tarball 隔离安装并检查运行依赖、类型声明和随包 skill |
| `pnpm test:game` | 只记录已连接真实游戏的只读快照，不代表完整任务通过 |

PR 中必须分别说明：

- 自动化测试运行了什么以及结果。
- mock 验证覆盖了什么，不把它描述成真实游戏结果。
- 是否进行真实游戏验证；未进行时明确写“未验证”。
- 实机验证使用专用测试存档及备份，不使用已有用户存档做破坏性测试。

界面变更附修改后的截图。游戏行为变更附最小的前后状态摘要、游戏版本、SMAPI 版本和人工介入情况，不提交原始存档、凭据或完整本地运行目录。

## 分支、提交和 PR

从最新的 `main` 创建一个目标明确的分支：

```text
feat/<scope>-<summary>
fix/<scope>-<summary>
docs/<summary>
test/<scope>-<summary>
chore/<summary>
```

提交信息使用简洁的 Conventional Commits 风格，例如：

```text
feat(protocol): 增加商店购买动作
fix(agent): 避免取消后继续执行旧技能
test(mod): 覆盖过期目标引用
docs: 补充贡献指南
```

每个 PR 只解决一个明确问题。提交前请：

1. 更新或新增能证明行为的测试。
2. 运行对应检查并填写 PR 模板。
3. 确认没有提交 `.env`、Key、登录信息、用户存档、`work/` 内容或个人绝对路径。
4. 确认生成文件和无关格式化改动没有混入。

协议、Mod 写操作、取消与生命周期属于高风险改动，建议先创建功能提案 Issue 对齐契约。维护者可能要求在具备游戏环境的机器上补充实机验证后再合并。

## 审核和合并

PR 需要通过仓库 CI 和对应代码所有者审核。维护者主要检查：

- 改动是否遵守协议、CLI、dsh 插件和 Mod 的职责边界。
- 完成声明是否有机器判据或清楚标记为人工复核。
- 自动化、mock 和真实游戏证据是否明确区分。
- 失败、取消和恢复路径是否保持可诊断。

通常使用 squash merge，让主分支上的每个提交对应一个完整改动。共享分支不要改写他人历史；需要更新自己的 PR 分支时优先正常 push，只有确认远端状态后才使用 `--force-with-lease`。
