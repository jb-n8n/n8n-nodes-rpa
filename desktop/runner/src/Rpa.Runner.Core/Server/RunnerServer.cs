using System.Net;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Logging;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Server;

/// <summary>
/// The WebSocket endpoint: <c>wss://host:port/rpa/v1</c>, TLS only (Kestrel listens with the runner's certificate and no
/// plain listener exists), bearer token checked on the upgrade request (401, no upgrade, on a wrong or missing token).
/// </summary>
public sealed class RunnerServer : IAsyncDisposable
{
    public const string Path = "/rpa/v1";
    public const int MaxMessageBytes = 1024 * 1024;

    private readonly WebApplication _app;
    private readonly RunnerLog _log;

    private RunnerServer(WebApplication app, RunnerLog log)
    {
        _app = app;
        _log = log;
    }

    /// <summary>The port Kestrel bound (useful with port 0 in tests).</summary>
    public int Port { get; private set; }

    public static RunnerServer Create(IPAddress bind, int port, X509Certificate2 certificate, string token,
        RpcDispatcher dispatcher, RunnerLog log)
    {
        var expected = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        // No configuration from the environment or appsettings.json: nothing may add a plain-HTTP endpoint.
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = AppContext.BaseDirectory });
        builder.Configuration.Sources.Clear();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(k =>
        {
            k.AddServerHeader = false;
            k.Limits.MaxConcurrentConnections = 32;
            k.Limits.MaxRequestHeadersTotalSize = 16 * 1024;
            k.Listen(bind, port, o =>
            {
                o.Protocols = HttpProtocols.Http1;
                o.UseHttps(h =>
                {
                    h.ServerCertificate = certificate;
                    h.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13;
                });
            });
        });
        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });
        app.Run(async ctx =>
        {
            if (ctx.Request.Path != Path)
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            if (!TokenMatches(ctx.Request.Headers.Authorization.ToString(), expected))
            {
                if (RefusalLogGate.ShouldLog(out var suppressed))
                    log.Warn($"refused a connection from {ctx.Connection.RemoteIpAddress}: wrong or missing token" +
                             (suppressed > 0 ? $" ({suppressed} more refused since the last entry)" : ""));
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                ctx.Response.Headers.WWWAuthenticate = "Bearer";
                return;
            }
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            log.Info($"connection from {ctx.Connection.RemoteIpAddress}");
            await Serve(ws, dispatcher, log, ctx.RequestAborted);
            log.Info($"connection from {ctx.Connection.RemoteIpAddress} closed");
        });
        return new RunnerServer(app, log);
    }

    public async Task StartAsync()
    {
        await _app.StartAsync();
        var feature = _app.Services.GetService(typeof(Microsoft.AspNetCore.Hosting.Server.IServer)) as Microsoft.AspNetCore.Hosting.Server.IServer;
        var addresses = feature?.Features.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()?.Addresses;
        var first = addresses?.FirstOrDefault();
        Port = first is null ? 0 : new Uri(first).Port;
    }

    public async ValueTask DisposeAsync()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await _app.StopAsync(cts.Token);
        await _app.DisposeAsync();
    }

    /// <summary>At most one refused-token log line per second, so unauthenticated clients cannot flood the log.</summary>
    private static class RefusalLogGate
    {
        private static long _lastTicks;
        private static int _suppressed;

        public static bool ShouldLog(out int suppressed)
        {
            var now = Environment.TickCount64;
            var last = Interlocked.Read(ref _lastTicks);
            if (now - last < 1000 && last != 0)
            {
                Interlocked.Increment(ref _suppressed);
                suppressed = 0;
                return false;
            }
            Interlocked.Exchange(ref _lastTicks, now);
            suppressed = Interlocked.Exchange(ref _suppressed, 0);
            return true;
        }
    }

    internal static bool TokenMatches(string header, byte[] expectedHash)
    {
        const string prefix = "Bearer ";
        if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        var given = SHA256.HashData(Encoding.UTF8.GetBytes(header[prefix.Length..].Trim()));
        return CryptographicOperations.FixedTimeEquals(given, expectedHash);
    }

    private static async Task Serve(WebSocket ws, RpcDispatcher dispatcher, RunnerLog log, CancellationToken aborted)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        var sendLock = new SemaphoreSlim(1, 1);
        var pending = new List<Task>();
        var buffer = new byte[16 * 1024];
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult r;
                do
                {
                    r = await ws.ReceiveAsync(buffer, cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                        return;
                    }
                    ms.Write(buffer, 0, r.Count);
                    if (ms.Length > MaxMessageBytes)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too big", CancellationToken.None);
                        return;
                    }
                } while (!r.EndOfMessage);
                if (r.MessageType != WebSocketMessageType.Text)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "text messages only", CancellationToken.None);
                    return;
                }
                var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                pending.RemoveAll(t => t.IsCompleted);
                pending.Add(Task.Run(async () =>
                {
                    var response = await dispatcher.HandleAsync(text, cts.Token);
                    if (response is null) return;
                    await sendLock.WaitAsync(cts.Token);
                    try
                    {
                        if (ws.State == WebSocketState.Open)
                            await ws.SendAsync(Encoding.UTF8.GetBytes(response), WebSocketMessageType.Text, true, cts.Token);
                    }
                    finally
                    {
                        sendLock.Release();
                    }
                }));
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
        {
            // The client went away; the run, if any, stays under its lease.
        }
        finally
        {
            cts.Cancel();
            try { await Task.WhenAll(pending); }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or IOException)
            {
                log.Info("dropped responses for a closed connection");
            }
        }
    }
}
