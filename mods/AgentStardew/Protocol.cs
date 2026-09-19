using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentStardew;

public sealed record Request(int ProtocolVersion, string RequestId, string Command, JsonElement Args, int TimeoutMs = 15000, string? ActionId = null);
public sealed record Fault(string Code, string Message, bool Retryable = false);
public sealed record Response(int ProtocolVersion, string RequestId, string Status, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Result = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Fault? Error = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ActionId = null)
{
    public static Response Ok(Request r, object result) => new(1, r.RequestId, "completed", result, ActionId: r.ActionId);
    public static Response Fail(Request r, string code, string message, bool retryable = false, object? result = null) =>
        new(1, r.RequestId, code == "CANCELLED" ? "cancelled" : "failed", result, new(code, message, retryable), r.ActionId);
}
public sealed class ActionFault : Exception
{
    public string Code { get; }
    public ActionFault(string code, string message) : base(message) => Code = code;
}
public static class Protocol
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };
    public static readonly string[] Capabilities = { "snapshot", "move", "select", "use", "interact", "menu", "screenshot", "status", "stop" };
    public static void Validate(Request r)
    {
        string[] allowed = r.Command switch
        {
            "hello" or "snapshot" or "status" or "screenshot" or "stop" => r.Command == "snapshot" ? new[] { "radius" } : r.Command == "stop" ? new[] { "actionId" } : Array.Empty<string>(),
            "move" => new[] { "near", "tile" }, "select" => new[] { "slot" }, "use" or "interact" or "menu" => new[] { "target" },
            _ => throw new ActionFault("UNSUPPORTED", "未知命令。")
        };
        if (r.Args.EnumerateObject().Any(p => !allowed.Contains(p.Name))) throw new ActionFault("INVALID_ARGUMENT", "请求包含未知参数。");
        bool ValidId(string? id) => id != null && System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-zA-Z0-9_-]{1,80}$");
        if (IsWrite(r.Command) && !ValidId(r.ActionId)) throw new ActionFault("INVALID_ARGUMENT", "写动作需要有效 actionId。");
        if (r.Command == "snapshot" && r.Args.TryGetProperty("radius", out _) && (Integer(r.Args, "radius") < 1 || Integer(r.Args, "radius") > 16)) throw new ActionFault("INVALID_ARGUMENT", "radius 必须为 1–16。");
        if (r.Command == "select" && (Integer(r.Args, "slot") < 0 || Integer(r.Args, "slot") > 35)) throw new ActionFault("INVALID_ARGUMENT", "slot 必须为 0–35。");
        if (r.Command == "stop" && r.Args.TryGetProperty("actionId", out _) && !ValidId(Text(r.Args, "actionId"))) throw new ActionFault("INVALID_ARGUMENT", "actionId 无效。");
        if (r.Command is "use" or "interact" or "menu") CheckReference(Text(r.Args, "target"));
        if (r.Command == "move")
        {
            if (r.Args.TryGetProperty("near", out _) == r.Args.TryGetProperty("tile", out var tile)) throw new ActionFault("INVALID_ARGUMENT", "move 需要 near 或 tile，且互斥。");
            if (r.Args.TryGetProperty("near", out _)) CheckReference(Text(r.Args, "near"));
            else if (tile.ValueKind != JsonValueKind.Object || tile.EnumerateObject().Any(p => p.Name is not ("x" or "y")) || Integer(tile, "x") < 0 || Integer(tile, "y") < 0) throw new ActionFault("INVALID_ARGUMENT", "tile 需要非负整数 x、y。");
        }
    }
    private static void CheckReference(string reference)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(reference, "^@s[0-9]+:[em][0-9]+$")) throw new ActionFault("INVALID_ARGUMENT", "目标引用格式无效。");
    }
    public static bool IsWrite(string command) => command is "move" or "select" or "use" or "interact" or "menu";
    public static string Text(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
        ? value.GetString()! : throw new ActionFault("INVALID_ARGUMENT", $"缺少字符串参数 {key}。");
    public static int Integer(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
        ? number : throw new ActionFault("INVALID_ARGUMENT", $"缺少整数参数 {key}。");
}
