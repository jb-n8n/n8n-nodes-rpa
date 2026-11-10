using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Time.Testing;

namespace Rpa.Supervisor.Core.Tests;

public sealed class PortProxyTests : IAsyncLifetime
{
    private const string Bot = "rpabot";
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);
    private readonly List<string> _events = [];
    private readonly FakeSessions _sessions;
    private readonly RecordingLog _log = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly List<IDisposable> _cleanup = [];
    private Task? _proxy;

    public PortProxyTests() => _sessions = new FakeSessions(_events);

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        _stop.Cancel();
        if (_proxy is not null) await _proxy.WaitAsync(Patience);
        foreach (var item in _cleanup) item.Dispose();
    }

    private sealed record Setup(FakeRdpHost Host, int ListenPort, int TargetPort);

    private Setup Start(TimeProvider time, int idleSeconds = 15, int readySeconds = 45)
    {
        var listen = FreePort();
        var target = FreePort();
        var options = new SupervisorOptions(Bot, [new PortMap(listen, target)], ["127.0.0.1"], idleSeconds, readySeconds);
        var host = new FakeRdpHost(_sessions, time, _events);
        var manager = new SessionManager(_sessions, host, options, _log, time);
        _proxy = new PortProxy(manager, options, _log).RunAsync(_stop.Token);
        return new Setup(host, listen, target);
    }

    private static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private TcpListener Target(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        _cleanup.Add(new Stopper(listener));
        return listener;
    }

    private async Task<TcpClient> Connect(int port)
    {
        var client = new TcpClient();
        _cleanup.Add(client);
        await client.ConnectAsync(IPAddress.Loopback, port).WaitAsync(Patience);
        return client;
    }

    private async Task<TcpClient> Accept(TcpListener listener)
    {
        var client = await listener.AcceptTcpClientAsync().WaitAsync(Patience);
        _cleanup.Add(client);
        return client;
    }

    private static async Task<byte[]> Read(TcpClient client, int count)
    {
        var buffer = new byte[count];
        await client.GetStream().ReadExactlyAsync(buffer).AsTask().WaitAsync(Patience);
        return buffer;
    }

    // The other side ended the connection: an orderly end (0 bytes read) or a reset, with no byte before it.
    private static async Task AssertEnds(TcpClient client)
    {
        try
        {
            Assert.Equal(0, await client.GetStream().ReadAsync(new byte[1]).AsTask().WaitAsync(Patience));
        }
        catch (IOException)
        {
        }
    }

    private sealed class Stopper(TcpListener listener) : IDisposable
    {
        public void Dispose() => listener.Stop();
    }

    [Fact]
    public async Task Bytes_sent_before_the_target_is_ready_arrive_once_it_listens_in_order()
    {
        var setup = Start(TimeProvider.System);
        var client = await Connect(setup.ListenPort);
        var hello = Enumerable.Range(0, 300).Select(i => (byte)(i * 7)).ToArray();
        await client.GetStream().WriteAsync(hello);

        await Task.Delay(500);
        var inner = await Accept(Target(setup.TargetPort));

        Assert.Equal(hello, await Read(inner, 300));
    }

    [Fact]
    public async Task Both_directions_are_passed_and_closing_one_side_closes_the_other()
    {
        var setup = Start(TimeProvider.System);
        var target = Target(setup.TargetPort);

        var client = await Connect(setup.ListenPort);
        var inner = await Accept(target);
        await client.GetStream().WriteAsync("ping"u8.ToArray());
        Assert.Equal("ping", Encoding.ASCII.GetString(await Read(inner, 4)));
        await inner.GetStream().WriteAsync("pong"u8.ToArray());
        Assert.Equal("pong", Encoding.ASCII.GetString(await Read(client, 4)));
        client.Dispose();
        await AssertEnds(inner);

        var second = await Connect(setup.ListenPort);
        var secondInner = await Accept(target);
        secondInner.Dispose();
        await AssertEnds(second);
    }

    [Fact]
    public async Task A_connection_is_refused_and_closed_without_any_byte_sent_when_EnsureAsync_throws()
    {
        var setup = Start(TimeProvider.System);
        setup.Host.AlwaysFail = SessionFailure.NotAllowed;
        var target = Target(setup.TargetPort);

        var client = await Connect(setup.ListenPort);

        await AssertEnds(client);
        Assert.False(target.Pending());
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.NotAllowed);
    }

    [Fact]
    public async Task A_target_that_does_not_listen_within_ReadySeconds_closes_the_connection_and_logs_it()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time, readySeconds: 45);
        var client = await Connect(setup.ListenPort);
        var read = client.GetStream().ReadAsync(new byte[1]).AsTask();

        for (var i = 0; i < 200 && !read.IsCompleted; i++)
        {
            time.Advance(TimeSpan.FromSeconds(5));
            await Task.Delay(10);
        }

        Assert.Equal(0, await read.WaitAsync(Patience));
        Assert.Contains(_log.Failures, f => f.Message.Contains($"127.0.0.1:{setup.TargetPort}") && f.Message.Contains("45 s"));
    }

    [Fact]
    public async Task Each_connection_holds_the_session_and_releases_it_when_it_closes()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time, idleSeconds: 15);
        var target = Target(setup.TargetPort);
        var first = await Connect(setup.ListenPort);
        var firstInner = await Accept(target);
        var second = await Connect(setup.ListenPort);
        var secondInner = await Accept(target);
        await first.GetStream().WriteAsync("a"u8.ToArray());
        await second.GetStream().WriteAsync("b"u8.ToArray());
        await Read(firstInner, 1);
        await Read(secondInner, 1);
        Assert.Equal(1, setup.Host.Calls);

        time.Advance(TimeSpan.FromMinutes(10));
        Assert.Empty(_sessions.SignOuts);

        first.Dispose();
        await AssertEnds(firstInner);
        firstInner.Dispose();
        await Task.Delay(50);
        time.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(_sessions.SignOuts);

        second.Dispose();
        await AssertEnds(secondInner);
        secondInner.Dispose();
        for (var i = 0; i < 300 && _sessions.SignOuts.Count == 0; i++)
        {
            time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(10);
        }
        Assert.Single(_sessions.SignOuts);
        Assert.Empty(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task At_most_64_connections_wait_at_once_the_next_is_closed()
    {
        // A stolen-token or scanner flood must not pile up sign-ins.
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time);
        setup.Host.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiting = new List<TcpClient>();
        for (var i = 0; i < 64; i++) waiting.Add(await Connect(setup.ListenPort));

        var refused = await Connect(setup.ListenPort);

        await AssertEnds(refused);
        Assert.All(waiting, client => Assert.False(client.Client.Poll(0, SelectMode.SelectRead)));
        Assert.Equal(1, setup.Host.Calls);
        Assert.Contains(_log.Failures, f => f.Message.Contains("64"));
    }
}
