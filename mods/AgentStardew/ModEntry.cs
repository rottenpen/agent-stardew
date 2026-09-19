using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace AgentStardew;

public sealed class ModEntry : Mod
{
    private BridgeServer? server;
    private readonly ActionCoordinator actions = new();
    private readonly Observations observations = new();
    private readonly BackgroundUpdates background = new();
    private BridgeServer.Pending? screenshot;
    public override void Entry(IModHelper helper)
    {
        try { server = new BridgeServer(17654); }
        catch (Exception error) { Monitor.Log($"启动本机桥接失败：{error.Message}", LogLevel.Error); return; }
        actions.OnError = error => Monitor.Log($"游戏动作失败：{error}", LogLevel.Error);
        helper.Events.GameLoop.GameLaunched += (_, _) => background.Initialize();
        helper.Events.GameLoop.UpdateTicking += OnTick;
        helper.Events.GameLoop.UpdateTicked += (_, _) => background.AfterUpdate();
        helper.Events.GameLoop.SaveLoaded += (_, _) => Reset();
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => Reset();
        helper.Events.Display.Rendered += OnRendered;
        Monitor.Log("Agent 桥接已监听 ws://127.0.0.1:17654/，支持游戏失焦时继续运行。", LogLevel.Info);
    }
    private void Reset()
    {
        actions.Reset(); observations.Reset(); server?.InvalidateSessions();
        if (screenshot is { } pending) Send(pending, Response.Fail(pending.Request, "STALE_REF", "存档会话已改变。"));
        screenshot = null;
    }
    private static void Send(BridgeServer.Pending pending, Response response) => _ = pending.Peer.Send(response);
    private void OnTick(object? sender, UpdateTickingEventArgs e)
    {
        if (server == null) return;
        background.BeforeUpdate();
        if (!Context.IsWorldReady) actions.Stop("STALE_REF", "存档未加载。");
        actions.Tick(DateTime.UtcNow, owner => ((BridgeServer.Peer)owner).Lifetime.IsCancellationRequested);
        if (screenshot is { } shot && (shot.Peer.Lifetime.IsCancellationRequested || DateTime.UtcNow >= shot.Received.AddMilliseconds(shot.Request.TimeoutMs)))
        { Send(shot, Response.Fail(shot.Request, "TIMEOUT", "截图等待绘制超时。")); screenshot = null; }
        for (var i = 0; i < 16 && server.Inbox.TryDequeue(out var pending); i++)
        {
            if (pending.Peer.Lifetime.IsCancellationRequested) continue;
            var r = pending.Request;
            try
            {
                Protocol.Validate(r);
                if (DateTime.UtcNow >= pending.Received.AddMilliseconds(r.TimeoutMs)) throw new ActionFault("TIMEOUT", "请求在队列中已过期。");
                if (r.Command == "hello")
                {
                    pending.Peer.Handshaken = true;
                    Send(pending, Response.Ok(r, new { mode = "game", kind = "hello", instanceId = observations.InstanceId, modVersion = ModManifest.Version.ToString(), gameVersion = Game1.GetVersionString(), smapiVersion = Constants.ApiVersion.ToString(), saveLoaded = Context.IsWorldReady, singlePlayer = !Context.IsMultiplayer, capabilities = Protocol.Capabilities }));
                    continue;
                }
                if (!pending.Peer.Handshaken) throw new ActionFault("INCOMPATIBLE_PROTOCOL", "需要先发送 hello。");
                if (r.Command == "status") { Send(pending, Response.Ok(r, actions.Status)); continue; }
                if (r.Command == "stop")
                {
                    var id = r.Args.TryGetProperty("actionId", out _) ? Protocol.Text(r.Args, "actionId") : null;
                    if (id == null || id == actions.ActiveId) actions.Stop();
                    Send(pending, Response.Ok(r, actions.Status)); continue;
                }
                if (!Context.IsWorldReady) throw new ActionFault("NO_SAVE_LOADED", "请先加载单人存档。");
                if (Context.IsMultiplayer) throw new ActionFault("UNSUPPORTED", "当前只支持单人存档。");
                if (r.Command == "snapshot")
                {
                    Send(pending, Response.Ok(r, observations.Snapshot(r.Args.TryGetProperty("radius", out _) ? Protocol.Integer(r.Args, "radius") : 8))); continue;
                }
                if (r.Command == "screenshot")
                {
                    if (screenshot != null) throw new ActionFault("BUSY", "已有截图请求。");
                    screenshot = pending; continue;
                }
                actions.Start(r, pending.Peer, pending.Received.AddMilliseconds(r.TimeoutMs), () => GameActions.Create(r, observations, Helper.Reflection), response => Send(pending, response));
            }
            catch (ActionFault error) { Send(pending, Response.Fail(r, error.Code, error.Message)); }
            catch (Exception error) { Monitor.Log($"处理 {r.Command} 失败：{error}", LogLevel.Error); Send(pending, Response.Fail(r, "INTERNAL_ERROR", "游戏桥接异常，请查看 SMAPI 日志。")); }
        }
    }
    private void OnRendered(object? sender, RenderedEventArgs e)
    {
        if (screenshot is not { } pending) return;
        screenshot = null;
        try
        {
            var device = Game1.graphics.GraphicsDevice;
            var width = device.PresentationParameters.BackBufferWidth; var height = device.PresentationParameters.BackBufferHeight;
            if ((long)width * height > 8388608) throw new ActionFault("OUTPUT_LIMIT", "画面尺寸过大，请降低窗口分辨率。");
            var colors = new Color[width * height]; device.GetBackBufferData(colors);
            using var texture = new Texture2D(device, width, height); texture.SetData(colors);
            using var bytes = new MemoryStream(); texture.SaveAsPng(bytes, width, height);
            if (bytes.Length > 2800000) throw new ActionFault("OUTPUT_LIMIT", "PNG 超出协议大小，请降低窗口分辨率。");
            Send(pending, Response.Ok(pending.Request, new { kind = "screenshot", mimeType = "image/png", base64 = Convert.ToBase64String(bytes.ToArray()) }));
        }
        catch (Exception error) { Send(pending, Response.Fail(pending.Request, error is ActionFault fault ? fault.Code : "INTERNAL_ERROR", $"截图失败：{error.Message}")); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { actions.Stop(); background.Dispose(); server?.Dispose(); }
        base.Dispose(disposing);
    }
}
