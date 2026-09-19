using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace AgentStardew;

// 网络线程只处理帧和有界队列；所有游戏 API 均由 ModEntry 的主线程回调使用。
public sealed class BridgeServer : IDisposable
{
    public sealed class Peer : IDisposable
    {
        public WebSocket Socket { get; }
        public CancellationTokenSource Lifetime { get; } = new();
        public bool Handshaken { get; set; }
        private readonly SemaphoreSlim sending = new(1);
        public Peer(WebSocket socket) => Socket = socket;
        public async Task Send(Response response)
        {
            try
            {
                await sending.WaitAsync(Lifetime.Token);
                try
                {
                    var data = JsonSerializer.SerializeToUtf8Bytes(response, Protocol.Json);
                    await Socket.SendAsync(data, WebSocketMessageType.Text, true, Lifetime.Token);
                }
                finally { sending.Release(); }
            }
            catch (Exception) { Lifetime.Cancel(); }
        }
        public void Dispose() { Lifetime.Cancel(); Socket.Abort(); Socket.Dispose(); }
    }
    public sealed record Pending(Peer Peer, Request Request, DateTime Received);
    public readonly ConcurrentQueue<Pending> Inbox = new();
    private readonly HttpListener listener = new();
    private readonly ConcurrentDictionary<Peer, byte> peers = new();
    private readonly CancellationTokenSource shutdown = new();
    public BridgeServer(int port)
    {
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        _ = Accept();
    }
    private async Task Accept()
    {
        while (!shutdown.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch (Exception) when (shutdown.IsCancellationRequested) { return; }
            // CLI 不发送 Origin；拒绝网页来源，防止网页借本机端口操作游戏。
            if (!context.Request.IsWebSocketRequest || context.Request.Headers["Origin"] != null || peers.Count >= 16)
            { context.Response.StatusCode = 403; context.Response.Close(); continue; }
            _ = Serve(context);
        }
    }
    private async Task Serve(HttpListenerContext context)
    {
        Peer? peer = null;
        try
        {
            peer = new Peer((await context.AcceptWebSocketAsync(null)).WebSocket);
            peers.TryAdd(peer, 0);
            var buffer = new byte[8192];
            while (!peer.Lifetime.IsCancellationRequested)
            {
                using var frame = new MemoryStream();
                WebSocketReceiveResult read;
                do
                {
                    read = await peer.Socket.ReceiveAsync(new ArraySegment<byte>(buffer), peer.Lifetime.Token);
                    if (read.MessageType != WebSocketMessageType.Text) return;
                    frame.Write(buffer, 0, read.Count);
                    if (frame.Length > 65536) return;
                } while (!read.EndOfMessage);
                Request? request;
                try { request = JsonSerializer.Deserialize<Request>(frame.ToArray(), Protocol.Json); }
                catch (JsonException) { return; }
                if (request == null || string.IsNullOrEmpty(request.RequestId) || request.RequestId.Length > 80) return;
                if (request.ProtocolVersion != 1) { await peer.Send(Response.Fail(request, "INCOMPATIBLE_PROTOCOL", "需要协议版本 1。")); continue; }
                if (request.Args.ValueKind != JsonValueKind.Object || request.TimeoutMs < 100 || request.TimeoutMs > 120000)
                { await peer.Send(Response.Fail(request, "INVALID_ARGUMENT", "args 或 timeoutMs 无效。")); continue; }
                if (Inbox.Count >= 64) { await peer.Send(Response.Fail(request, "BUSY", "请求队列已满。", true)); continue; }
                Inbox.Enqueue(new(peer, request, DateTime.UtcNow));
            }
        }
        catch (Exception) { /* 对端退出只终止自己的连接，由主线程释放该连接拥有的动作。 */ }
        finally { if (peer != null) { peers.TryRemove(peer, out _); peer.Dispose(); } }
    }
    public void InvalidateSessions()
    {
        foreach (var peer in peers.Keys) peer.Handshaken = false;
    }
    public void Dispose()
    {
        shutdown.Cancel(); listener.Close();
        foreach (var peer in peers.Keys) peer.Dispose();
    }
}
