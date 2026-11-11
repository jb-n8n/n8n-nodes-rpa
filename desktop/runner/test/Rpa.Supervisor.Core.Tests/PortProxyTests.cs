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

    private sealed record Setup(FakeRdpHost Host, SessionManager Manager, int ListenPort, int TargetPort);

    private Setup Start(TimeProvider time, int idleSeconds = 15, int readySeconds = 45, string stateFile = "")
    {
        var listen = FreePort();
        var target = FreePort();
        var options = new SupervisorOptions(Bot, [new PortMap(listen, target)], ["127.0.0.1"], idleSeconds, readySeconds,
            stateFile);
        var host = new FakeRdpHost(_sessions, time, _events);
        var manager = new SessionManager(_sessions, host, new FakeRemoteDesktop(), options, _log, time);
        _proxy = new PortProxy(manager, options, _log).RunAsync(_stop.Token);
        return new Setup(host, manager, listen, target);
    }

    // Advances the fake time in steps until the condition holds.
    private static async Task DriveUntil(FakeTimeProvider time, Func<bool> done, TimeSpan step)
    {
        for (var i = 0; i < 300 && !done(); i++)
        {
            time.Advance(step);
            await Task.Delay(10);
        }
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
    public async Task A_client_that_connects_and_closes_with_a_reset_does_not_stop_the_listener()
    {
        // A scanner or a TCP health check does this.
        var setup = Start(TimeProvider.System);
        var target = Target(setup.TargetPort);
        for (var i = 0; i < 3; i++)
        {
            using var reset = new TcpClient { LingerState = new LingerOption(true, 0) };
            await reset.ConnectAsync(IPAddress.Loopback, setup.ListenPort).WaitAsync(Patience);
            reset.Close();
        }
        await Task.Delay(100);

        var client = await Connect(setup.ListenPort);
        await client.GetStream().WriteAsync("ping"u8.ToArray());

        // A reset that came after the accept is served like any connection and ends at once: skip those.
        for (var i = 0; i < 4; i++)
        {
            var inner = await Accept(target);
            try
            {
                Assert.Equal("ping", Encoding.ASCII.GetString(await Read(inner, 4)));
                return;
            }
            catch (Exception e) when (e is EndOfStreamException or IOException)
            {
            }
        }
        Assert.Fail("the connection after the resets was not served");
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
    public async Task A_runner_that_does_not_start_in_the_session_is_the_last_failure_and_names_its_log()
    {
        var dir = Directory.CreateTempSubdirectory("rpa-supervisor-").FullName;
        _cleanup.Add(new Deleter(dir));
        var stateFile = Path.Combine(dir, "supervisor-state.json");
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time, readySeconds: 45, stateFile: stateFile);
        var client = await Connect(setup.ListenPort);
        var read = client.GetStream().ReadAsync(new byte[1]).AsTask();

        await DriveUntil(time, () => read.IsCompleted, TimeSpan.FromSeconds(5));

        Assert.Equal(0, await read.WaitAsync(Patience));
        var expected = $"Nothing listened on 127.0.0.1:{setup.TargetPort} within 45 s: the runner did not start in {Bot}'s session; " +
            $"read %ProgramData%\\RPA Runner\\logs\\runner.out.log. The connection to port {setup.ListenPort} is closed.";
        Assert.Equal(expected, setup.Manager.LastFailure);
        Assert.Contains("Nothing listened on 127.0.0.1", File.ReadAllText(stateFile));
        Assert.Contains(_log.Failures, f => f.Reason is null && f.Message == expected);
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

    [Fact]
    public async Task A_sign_in_that_keeps_failing_leaves_LastFailure_set_and_written_to_the_state_file_and_the_client_is_closed()
    {
        var dir = Directory.CreateTempSubdirectory("rpa-supervisor-").FullName;
        _cleanup.Add(new Deleter(dir));
        var stateFile = Path.Combine(dir, "supervisor-state.json");
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time, readySeconds: 45, stateFile: stateFile);
        setup.Host.AlwaysFail = SessionFailure.HostExited;
        var client = await Connect(setup.ListenPort);
        var read = client.GetStream().ReadAsync(new byte[1]).AsTask();

        await DriveUntil(time, () => read.IsCompleted, TimeSpan.FromSeconds(1));

        Assert.Equal(0, await read.WaitAsync(Patience));
        Assert.StartsWith("HostExited", setup.Manager.LastFailure);
        Assert.Contains("\"lastFailure\":\"HostExited", File.ReadAllText(stateFile));
        // The connection ends with the sign-in's reason, not as a timeout of its own.
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.HostExited);
        Assert.DoesNotContain(_log.Failures, f => f.Reason == SessionFailure.Timeout);
    }

    [Fact]
    public async Task A_connection_whose_session_went_away_while_it_waited_for_its_target_ends_with_the_sign_ins_reason()
    {
        var setup = Start(TimeProvider.System);
        var client = await Connect(setup.ListenPort);
        for (var i = 0; i < 500 && setup.Host.Connections.Count == 0; i++) await Task.Delay(10);

        // The session's Remote Desktop connection ends before anything listens; signing in again fails.
        setup.Host.AlwaysFail = SessionFailure.NotAllowed;
        setup.Host.Connections[0].Drop();

        await AssertEnds(client);
        Assert.Equal(2, setup.Host.Calls);
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.NotAllowed);
        Assert.DoesNotContain(_log.Failures, f => f.Message.Contains("Nothing listened"));
    }

    [Fact]
    public async Task A_connection_whose_target_ended_is_closed_and_the_session_is_signed_out_after_IdleSeconds()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
        var setup = Start(time, idleSeconds: 15);
        // The target listens first: with fake time the proxy's poll would wait for the clock.
        var target = Target(setup.TargetPort);
        var client = await Connect(setup.ListenPort);
        var inner = await Accept(target);
        await client.GetStream().WriteAsync("a"u8.ToArray());
        await Read(inner, 1);

        // The target ends; the client stays open and says nothing.
        inner.Dispose();
        await AssertEnds(client);
        await DriveUntil(time, () => _sessions.SignOuts.Count > 0, TimeSpan.FromSeconds(1));

        Assert.Single(_sessions.SignOuts);
        Assert.Empty(_sessions.ForUser(Bot));
    }

    private sealed class Deleter(string dir) : IDisposable
    {
        public void Dispose() => Directory.Delete(dir, true);
    }
}
