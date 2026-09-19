# CLI 操作

构建后通过 `node packages/cli/dist/bin.js` 使用。以下命令均在仓库根目录执行；发行包安装后可直接使用 `agent-stardew`。

```sh
node packages/cli/dist/bin.js doctor --json
node packages/cli/dist/bin.js snapshot --radius 4
node packages/cli/dist/bin.js move --tile 12 8
node packages/cli/dist/bin.js move --near @s17:e3
node packages/cli/dist/bin.js select --slot 3
node packages/cli/dist/bin.js use @s17:e3
node packages/cli/dist/bin.js interact @s17:e5
node packages/cli/dist/bin.js menu choose @s18:m1
node packages/cli/dist/bin.js screenshot --output work/farm.png
node packages/cli/dist/bin.js status --json
node packages/cli/dist/bin.js stop --action-id <动作编号> --json
```

坐标、引用和槽位是示例值。每次使用实际快照中的内容；槽位从 0 开始。引用保存最近 16 次快照，在切换存档、离开地图或实体消失后失效。地图自动出口需要移动到对应格子；对话和睡觉选项通过菜单引用执行。

默认连接 `ws://127.0.0.1:17654/`。使用 `--endpoint ws://127.0.0.1:17655/` 连接独立模拟服务。`snapshot` 与握手结果包含 `mode: game | mock`。只允许回环地址；Mod 拒绝携带网页 Origin 的 WebSocket。

安装当前 Mod 后，游戏失去焦点时仍可处理查询、移动和其他动作，不必将游戏窗口保持在前台。Mod 在更新期间临时绕过失焦暂停，保留玩家保存的选项；macOS 下运行时关闭垂直同步，避免窗口被遮挡时主循环停滞。后台游戏时间会继续推进。更新 Mod 后需重启游戏才能生效。

`--json` 在 stdout 输出一个规范 JSON，退出码为成功 0、参数错误 2、其他失败 1、取消 130。`--timeout` 范围为 100–120000 毫秒。`doctor` 先检查游戏、SMAPI 和已安装 Mod，再进行握手；`pnpm run doctor` 同时检查 Node、dsh 与构建产物。

写动作支持 `--action-id`。同一存档会话中，相同 ID 和参数只执行一次；参数变化被拒绝。Mod 缓存最近 256 个终态，淘汰终态后仍拒绝再次执行旧 ID。每个存档会话最多记录 4096 个动作，达到上限时需要在保存后重新加载游戏。

取消和超时会请求停止对应动作，连接断开也会停止该连接的后续自动动作。已经触发的工具动画和资源消耗由游戏完成，不自动回滚。错误后先重新观察，不能把请求超时当作没有执行。

当前游戏实现支持寻路移动、选择槽位、工具/种子使用、场景交互、对话菜单和截图。交互及工具动作只在能验证状态变化时报告完成。商店、复杂菜单等未支持操作返回 `UNSUPPORTED`；实际农务成功率仍需专用游戏存档验证。

给水壶补水时，先从快照选取 `refillable=true` 的水源，移动到相邻位置，选择水壶，再用最新引用执行 `use`。水壶的 `water` 与 `waterCapacity` 分别表示当前水量和容量，结果需要显示水量增加。作物的 `needsWater` 表示当前是否需要浇水；普通自主任务默认跳过空耕地。
