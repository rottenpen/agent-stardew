using System.Text.Json;

namespace AgentStardew;

public interface IGameAction
{
    object? Tick();
    void Cancel();
}

// 主线程持有唯一写动作；终态缓存和已用 ID 分开，缓存淘汰也不能重放消费操作。
public sealed class ActionCoordinator
{
    private sealed record Active(Request Request, object Owner, IGameAction Action, DateTime Deadline, Action<Response> Reply);
    private Active? active;
    private readonly Dictionary<string, string> seen = new();
    private readonly Dictionary<string, Response> completed = new();
    private readonly Queue<string> order = new();
    public Action<Exception>? OnError { get; set; }
    public string? ActiveId => active?.Request.ActionId;
    public object Status => new { kind = "status", activeActionId = ActiveId, command = active?.Request.Command };

    private static string Signature(Request r) => r.Command + ":" + Canonical(r.Args);
    private static string Canonical(JsonElement value) => value.ValueKind == JsonValueKind.Object
        ? "{" + string.Join(",", value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}"
        : value.ValueKind == JsonValueKind.Array ? "[" + string.Join(",", value.EnumerateArray().Select(Canonical)) + "]" : value.GetRawText();

    public void Start(Request request, object owner, DateTime deadline, Func<IGameAction> create, Action<Response> reply)
    {
        var id = request.ActionId!;
        if (seen.TryGetValue(id, out var signature))
        {
            if (signature != Signature(request)) { reply(Response.Fail(request, "INVALID_ARGUMENT", "同一 actionId 不能用于不同参数。")); return; }
            if (completed.TryGetValue(id, out var previous)) { reply(previous with { RequestId = request.RequestId }); return; }
            reply(Response.Fail(request, active?.Request.ActionId == id ? "BUSY" : "STALE_REF", "该动作已提交；查询状态并重新观察，不能重新执行。"));
            return;
        }
        if (active != null) { reply(Response.Fail(request, "BUSY", "已有动作正在执行。", true)); return; }
        if (seen.Count >= 4096) { reply(Response.Fail(request, "OUTPUT_LIMIT", "本次存档会话已达动作记录上限，请在存档后重新加载。")); return; }
        // 先记录 ID：即使创建动作时游戏抛错，重试也不能再次消费物品。
        seen.Add(id, Signature(request));
        try { active = new(request, owner, create(), deadline, reply); }
        catch (Exception error) { if (error is not ActionFault) OnError?.Invoke(error); var response = Fault(request, error); Remember(response); reply(response); }
    }

    public void Tick(DateTime now, Func<object, bool> disconnected)
    {
        if (active == null) return;
        if (disconnected(active.Owner)) { Stop("CANCELLED", "发起动作的连接已断开。" ); return; }
        if (now >= active.Deadline) { Stop("TIMEOUT", "游戏动作超时，已停止后续操作。" ); return; }
        try
        {
            var result = active.Action.Tick();
            if (result != null) Finish(Response.Ok(active.Request, result));
        }
        catch (Exception error) { if (error is not ActionFault) OnError?.Invoke(error); Finish(Fault(active!.Request, error)); }
    }

    public void Stop(string code = "CANCELLED", string message = "已停止自动动作。")
    {
        if (active != null) Finish(Response.Fail(active.Request, code, message));
    }
    public void Reset()
    {
        Stop("STALE_REF", "存档会话已改变。");
        seen.Clear(); completed.Clear(); order.Clear();
    }
    private void Finish(Response response)
    {
        var prior = active!;
        active = null;
        try { prior.Action.Cancel(); }
        catch (Exception error) { OnError?.Invoke(error); response = Fault(prior.Request, error); }
        Remember(response); prior.Reply(response);
    }
    private void Remember(Response response)
    {
        completed[response.ActionId!] = response;
        order.Enqueue(response.ActionId!);
        while (order.Count > 256) completed.Remove(order.Dequeue());
    }
    private static Response Fault(Request request, Exception error) => error is ActionFault fault
        ? Response.Fail(request, fault.Code, fault.Message) : Response.Fail(request, "INTERNAL_ERROR", "游戏动作发生异常，请重新观察并查看 SMAPI 日志。");
}
