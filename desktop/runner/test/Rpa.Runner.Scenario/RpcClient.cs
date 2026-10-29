using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rpa.Runner.Scenario;

/// <summary>A JSON-RPC error returned by the runner.</summary>
public sealed class RunnerError(int code, string message) : Exception($"{code}: {message}")
{
    public int Code { get; } = code;
    public string RunnerMessage { get; } = message;
}

/// <summary>
/// A minimal client as n8n would be: pins the runner's certificate by SHA-256 fingerprint (TLS fails before the token
/// is sent if it does not match), sends the bearer token on the upgrade, one request per message.
/// </summary>
public sealed class RpcClient : IAsyncDisposable
{
    private readonly ClientWebSocket _ws;
    private int _id;

    private RpcClient(ClientWebSocket ws) => _ws = ws;

    public static async Task<RpcClient> ConnectAsync(Uri url, string token, string fingerprint)
    {
        var ws = Create(token, fingerprint);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await ws.ConnectAsync(url, cts.Token);
        return new RpcClient(ws);
    }

    /// <summary>Tries to connect and returns the HTTP status of the refused upgrade.</summary>
    public static async Task<HttpStatusCode> RefusedStatusAsync(Uri url, string? token, string fingerprint)
    {
        using var ws = Create(token, fingerprint);
        try
        {
            await ws.ConnectAsync(url, CancellationToken.None);
            return HttpStatusCode.SwitchingProtocols;
        }
        catch (WebSocketException)
        {
            return ws.HttpStatusCode;
        }
    }

    private static ClientWebSocket Create(string? token, string fingerprint)
    {
        var ws = new ClientWebSocket();
        ws.Options.CollectHttpResponseDetails = true;
        if (token is not null) ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        ws.Options.RemoteCertificateValidationCallback = (_, cert, _, _) =>
            cert is not null && string.Equals(Fingerprint(cert.GetRawCertData()), fingerprint, StringComparison.OrdinalIgnoreCase);
        return ws;
    }

    public static string Fingerprint(byte[] der) => string.Join(':', SHA256.HashData(der).Select(b => b.ToString("X2")));

    public async Task<JsonNode> CallAsync(string method, object? @params = null, int timeoutSeconds = 120)
    {
        var id = Interlocked.Increment(ref _id);
        var req = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = @params is null ? new JsonObject() : JsonSerializer.SerializeToNode(@params) };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
        await _ws.SendAsync(Encoding.UTF8.GetBytes(req.ToJsonString()), WebSocketMessageType.Text, true, cts.Token);
        while (true)
        {
            var resp = await ReceiveAsync(cts.Token);
            if (resp["id"]?.GetValue<int>() != id) continue;
            if (resp["error"] is JsonObject err)
                throw new RunnerError(err["code"]!.GetValue<int>(), err["message"]!.GetValue<string>());
            return resp["result"]!;
        }
    }

    private async Task<JsonObject> ReceiveAsync(CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        using var ms = new MemoryStream();
        WebSocketReceiveResult r;
        do
        {
            r = await _ws.ReceiveAsync(buf, ct);
            if (r.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("the runner closed the connection");
            ms.Write(buf, 0, r.Count);
        } while (!r.EndOfMessage);
        return JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray()))!.AsObject();
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        _ws.Dispose();
    }
}
