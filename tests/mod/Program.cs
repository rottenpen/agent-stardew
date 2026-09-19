using AgentStardew;
using System.Text.Json;
using System.Net.WebSockets;

var coordinator = new ActionCoordinator();
var owner = new object();
var replies = new List<Response>();
var now = DateTime.UtcNow;
Request Request(string id, int slot = 0) => new(1, Guid.NewGuid().ToString(), "select", JsonSerializer.SerializeToElement(new { slot }), 1000, id);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); Console.WriteLine("通过：" + message); }
var action = new FakeAction();
var request = Request("a");
coordinator.Start(request, owner, now.AddSeconds(10), () => action, replies.Add);
coordinator.Start(Request("b"), owner, now.AddSeconds(10), () => throw new Exception("不得运行"), replies.Add);
Check(replies.Last().Error?.Code == "BUSY", "并发写返回 BUSY");
coordinator.Start(request with { RequestId = "retry" }, owner, now.AddSeconds(10), () => throw new Exception("不得运行"), replies.Add);
Check(replies.Last().Error?.Code == "BUSY", "执行中相同动作不重放");
action.Done = true; coordinator.Tick(now, _ => false);
Check(replies.Last().Status == "completed" && action.Cancelled, "终态释放动作控制");
coordinator.Start(request with { RequestId = "replay" }, owner, now.AddSeconds(10), () => throw new Exception("不得运行"), replies.Add);
Check(replies.Last().Status == "completed" && replies.Last().RequestId == "replay", "缓存重放保留新请求 ID");
coordinator.Start(Request("a", 1), owner, now.AddSeconds(10), () => throw new Exception("不得运行"), replies.Add);
Check(replies.Last().Error?.Code == "INVALID_ARGUMENT", "相同动作 ID 不接受不同参数");
action = new FakeAction(); coordinator.Start(Request("c"), owner, now, () => action, replies.Add); coordinator.Tick(now, _ => false);
Check(replies.Last().Error?.Code == "TIMEOUT" && action.Cancelled, "超时取消实际动作");
action = new FakeAction(); coordinator.Start(Request("d"), owner, now.AddSeconds(10), () => action, replies.Add); coordinator.Tick(now, _ => true);
Check(replies.Last().Error?.Code == "CANCELLED" && action.Cancelled, "断连取消实际动作");
for (var i = 0; i < 260; i++) { coordinator.Start(Request("fill-" + i), owner, now.AddSeconds(10), () => new FakeAction { Done = true }, replies.Add); coordinator.Tick(now, _ => false); }
coordinator.Start(request, owner, now.AddSeconds(10), () => throw new Exception("不得运行"), replies.Add);
Check(replies.Last().Error?.Code == "STALE_REF", "终态缓存淘汰后依然禁止重复消费");
coordinator.Reset(); coordinator.Start(request, owner, now.AddSeconds(10), () => new FakeAction { Done = true }, replies.Add); coordinator.Tick(now, _ => false);
Check(replies.Last().Status == "completed", "新存档会话独立管理动作 ID");
var status = JsonSerializer.Serialize(Response.Ok(request, coordinator.Status), Protocol.Json);
Check(status.Contains("\"activeActionId\":null") && !status.Contains("\"error\""), "C# 结果保留必需 null 并省略可选错误字段");
try { Protocol.Validate(Request("x") with { Args = JsonSerializer.SerializeToElement(new { slot = 40 }) }); throw new Exception("应拒绝参数"); } catch (ActionFault fault) { Check(fault.Code == "INVALID_ARGUMENT", "C# 独立校验参数边界"); }
Check(InteractionEvidence.Changed(false, true, false, false), "交互打开菜单可判定完成");
Check(InteractionEvidence.Changed(false, false, true, false), "交互改变背包可判定完成");
Check(InteractionEvidence.Changed(false, false, false, true), "交互移除目标可判定完成");
Check(!InteractionEvidence.Changed(false, false, false, false), "交互无可验证变化时保持失败");
var movement = new MovementInput();
bool[] InputFrame(int? direction = null)
{
    if (direction.HasValue) movement.Direction = direction.Value;
    // 模拟失焦前遗留的工具、交互和方向按键，确认不会混入 Agent 的移动。
    var flags = Enumerable.Repeat(true, 18).ToArray();
    movement.SimulateInput(ref flags[0], ref flags[1], ref flags[2], ref flags[3], ref flags[4], ref flags[5],
        ref flags[6], ref flags[7], ref flags[8], ref flags[9], ref flags[10], ref flags[11], ref flags[12], ref flags[13],
        ref flags[14], ref flags[15], ref flags[16], ref flags[17]);
    return flags;
}
var frame = InputFrame(1);
Check(!frame.Take(6).Any(v => v) && frame[7] && frame[15] && frame.Skip(14).Count(v => v) == 1, "移动只注入目标方向，不触发残留工具或交互输入");
frame = InputFrame(1);
Check(!frame[7] && frame[15] && !frame[11], "连续移动保持按住，不重复按下或释放当前方向");
frame = InputFrame(0);
Check(frame[6] && frame[14] && frame[11] && !frame[15], "转向时释放上一方向并按下新方向");
frame = InputFrame();
Check(!frame.Skip(6).Take(4).Any(v => v) && !frame.Skip(14).Any(v => v) && frame.Skip(10).Take(4).All(v => v), "没有新的动作输入时下一帧释放全部方向");
// 通过真实 BridgeServer 网络线程与主线程队列读写，验证 JSON 帧和握手传输。
var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); listener.Start(); var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
using (var server = new BridgeServer(port))
using (var socket = new ClientWebSocket())
{
    using var timeout = new CancellationTokenSource(5000);
    await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/"), timeout.Token);
    var hello = new Request(1, "hello-test", "hello", JsonSerializer.SerializeToElement(new { }), 1000);
    await socket.SendAsync(new ArraySegment<byte>(JsonSerializer.SerializeToUtf8Bytes(hello, Protocol.Json)), WebSocketMessageType.Text, true, timeout.Token);
    BridgeServer.Pending? pending = null;
    while (!server.Inbox.TryDequeue(out pending)) await Task.Delay(5, timeout.Token);
    Check(pending.Request.Command == "hello", "WebSocket 请求进入有界队列");
    await pending.Peer.Send(Response.Ok(pending.Request, coordinator.Status));
    var bytes = new byte[4096]; var read = await socket.ReceiveAsync(new ArraySegment<byte>(bytes), timeout.Token);
    Check(JsonDocument.Parse(bytes.AsMemory(0, read.Count)).RootElement.GetProperty("requestId").GetString() == "hello-test", "WebSocket 返回对应请求终态");
}
Console.WriteLine("C# 调度及协议验证通过；不包含真实游戏动作验证。");

sealed class FakeAction : IGameAction
{
    public bool Done { get; set; }
    public bool Cancelled { get; private set; }
    public object? Tick() => Done ? new { kind = "status", activeActionId = (string?)null, command = (string?)null } : null;
    public void Cancel() => Cancelled = true;
}
