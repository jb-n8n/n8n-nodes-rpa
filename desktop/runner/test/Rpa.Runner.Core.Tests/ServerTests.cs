using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Rpa.Runner.Core.Server;

namespace Rpa.Runner.Core.Tests;

public sealed class ServerTests : IAsyncLifetime
{
    // Synthetic and low-entropy on purpose: not a secret.
    private static readonly string GoodToken = new('t', 32);
    private readonly string _dir = Directory.CreateTempSubdirectory("rpa-server-").FullName;
    private RunnerHost _host = null!;
    private readonly FakeDesktop _desktop = new();

    public async Task InitializeAsync()
    {
        var policy = Path.Combine(_dir, "policy.json");
        File.WriteAllText(policy, """{ "allowedApps": [{ "exe": "ErpDemo.exe" }] }""");
        var options = RunnerOptions.Parse(["--port", "0", "--bind", "127.0.0.1", "--data-dir", _dir, "--policy", policy],
            name => name == "RPA_RUNNER_TOKEN" ? GoodToken : null);
        _host = await RunnerHost.StartAsync(options, _desktop, new FakeProcessHost(), new NoKeyProtection(), TimeProvider.System,
            RunnerLog.Silent, "0.1.0-test");
    }

    public async Task DisposeAsync()
    {
        await _host.DisposeAsync();
        Directory.Delete(_dir, true);
    }

    private Uri Url => new($"wss://127.0.0.1:{_host.Port}/rpa/v1");

    private ClientWebSocket Client(string? token, string? pin = null)
    {
        var ws = new ClientWebSocket();
        if (token is not null) ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        pin ??= _host.Fingerprint;
        ws.Options.RemoteCertificateValidationCallback = (_, cert, _, _) =>
            cert is not null && string.Equals(Fingerprint(cert.GetRawCertData()), pin, StringComparison.Ordinal);
        ws.Options.CollectHttpResponseDetails = true;
        return ws;
    }

    private static string Fingerprint(byte[] der) => string.Join(':', SHA256.HashData(der).Select(b => b.ToString("X2")));

    [Fact]
    public void The_fingerprint_is_uppercase_colon_separated_sha256()
    {
        Assert.Matches(new Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$"), _host.Fingerprint);
    }

    [Fact]
    public async Task Hello_over_wss_with_the_token_and_the_pinned_certificate()
    {
        using var ws = Client(GoodToken);
        await ws.ConnectAsync(Url, default);
        var resp = await Call(ws, """{"jsonrpc":"2.0","id":7,"method":"hello","params":{}}""");
        Assert.Equal(7, resp["id"]!.GetValue<int>());
        Assert.Equal(1, resp["result"]!["protocol"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("wrong-token-wrong-token-wrong")]
    [InlineData("")]
    public async Task A_wrong_or_missing_token_gets_401_and_no_upgrade(string? token)
    {
        using var ws = Client(token);
        await Assert.ThrowsAsync<WebSocketException>(() => ws.ConnectAsync(Url, default));
        Assert.Equal(HttpStatusCode.Unauthorized, ws.HttpStatusCode);
    }

    [Fact]
    public async Task Requests_without_websocket_upgrade_also_need_the_token()
    {
        using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, _, _, _) => true };
        using var http = new HttpClient(handler);
        var r = await http.GetAsync($"https://127.0.0.1:{_host.Port}/rpa/v1");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"https://127.0.0.1:{_host.Port}/")).StatusCode);
    }

    [Fact]
    public async Task Plain_ws_is_refused()
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {GoodToken}");
        await Assert.ThrowsAnyAsync<Exception>(() => ws.ConnectAsync(new Uri($"ws://127.0.0.1:{_host.Port}/rpa/v1"), default));
        Assert.NotEqual(WebSocketState.Open, ws.State);
    }

    [Fact]
    public async Task A_client_pinning_another_fingerprint_never_sends_the_token()
    {
        using var ws = Client(GoodToken, pin: string.Join(':', Enumerable.Repeat("00", 32)));
        await Assert.ThrowsAnyAsync<Exception>(() => ws.ConnectAsync(Url, default));
        Assert.NotEqual(HttpStatusCode.Unauthorized, ws.HttpStatusCode); // TLS failed before any HTTP
    }

    [Fact]
    public async Task Responses_echo_ids_and_requests_can_overlap()
    {
        using var ws = Client(GoodToken);
        await ws.ConnectAsync(Url, default);
        await Send(ws, """{"jsonrpc":"2.0","id":"a","method":"hello"}""");
        await Send(ws, """{"jsonrpc":"2.0","id":"b","method":"run.heartbeat","params":{"runId":"x"}}""");
        var ids = new HashSet<string> { (await Receive(ws))["id"]!.GetValue<string>(), (await Receive(ws))["id"]!.GetValue<string>() };
        Assert.Equal(["a", "b"], ids.Order());
    }

    [Fact]
    public async Task The_certificate_and_fingerprint_survive_a_restart()
    {
        var policy = Path.Combine(_dir, "policy.json");
        var options = RunnerOptions.Parse(["--port", "0", "--bind", "127.0.0.1", "--data-dir", _dir, "--policy", policy],
            name => name == "RPA_RUNNER_TOKEN" ? GoodToken : null);
        await using var second = await RunnerHost.StartAsync(options, _desktop, new FakeProcessHost(), new NoKeyProtection(),
            TimeProvider.System, RunnerLog.Silent, "0.1.0-test");
        Assert.Equal(_host.Fingerprint, second.Fingerprint);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(_dir, CertificateStore.FileName)));
    }

    private static async Task<JsonObject> Call(ClientWebSocket ws, string request)
    {
        await Send(ws, request);
        return await Receive(ws);
    }

    private static Task Send(ClientWebSocket ws, string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, default);

    private static async Task<JsonObject> Receive(ClientWebSocket ws)
    {
        var buf = new byte[1 << 20];
        var ms = new MemoryStream();
        WebSocketReceiveResult r;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        do
        {
            r = await ws.ReceiveAsync(buf, cts.Token);
            ms.Write(buf, 0, r.Count);
        } while (!r.EndOfMessage);
        return JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray()))!.AsObject();
    }
}

public class OptionsTests
{
    private static readonly string Token = new('k', 24);

    [Fact]
    public void Defaults_and_overrides()
    {
        var o = RunnerOptions.Parse([], n => n == "RPA_RUNNER_TOKEN" ? Token : null);
        Assert.Equal(8765, o.Port);
        Assert.Equal(IPAddress.Any, o.Bind);
        Assert.Equal(Path.Combine(o.DataDir, "policy.json"), o.PolicyPath);
        var env = new Dictionary<string, string> { ["RPA_RUNNER_TOKEN"] = Token, ["RPA_RUNNER_PORT"] = "9000", ["RPA_RUNNER_DATA_DIR"] = "/tmp/rpa-x" };
        var o2 = RunnerOptions.Parse(["--port", "9100"], n => env.GetValueOrDefault(n));
        Assert.Equal(9100, o2.Port);
        Assert.Equal(Path.GetFullPath("/tmp/rpa-x"), o2.DataDir);
    }

    [Fact]
    public void Reads_the_token_from_a_file()
    {
        var f = Path.GetTempFileName();
        File.WriteAllText(f, Token + "\n");
        Assert.Equal(Token, RunnerOptions.Parse(["--token-file", f], _ => null).Token);
        File.Delete(f);
    }

    [Theory]
    [InlineData("--token", "abcdefghijklmnopqrstuvwxyz")]
    [InlineData("--port", "99999")]
    [InlineData("--bind", "not-an-ip")]
    [InlineData("--frobnicate", "1")]
    public void Refuses_bad_options(string flag, string value)
    {
        var e = Assert.Throws<RunnerOptions.InvalidOptionsException>(() => RunnerOptions.Parse([flag, value], n => n == "RPA_RUNNER_TOKEN" ? Token : null));
        Assert.DoesNotContain("abcdefghijklmnopqrstuvwxyz", e.Message);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("short")]
    [InlineData("has a space in the middle of it")]
    public void Refuses_missing_short_or_odd_tokens(string? token)
    {
        var e = Assert.Throws<RunnerOptions.InvalidOptionsException>(() => RunnerOptions.Parse([], n => n == "RPA_RUNNER_TOKEN" ? token : null));
        if (token is not null) Assert.DoesNotContain(token, e.Message);
    }
}
