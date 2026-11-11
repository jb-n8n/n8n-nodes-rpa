using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Rpa.Supervisor.Core;

/// <summary>
/// Listens on each of ListenAddresses for each PortMap. For each connection it holds the session, waits for
/// EnsureAsync and then for something to listen on 127.0.0.1 at the map's target port (together at most ReadySeconds),
/// and passes bytes both ways without reading them. Bytes the client sends while it waits stay in the socket and are
/// passed on in order. When the client ends its side, the end is passed on and the target's answer still flows back;
/// when the target ends, the connection ends. A connection that ends before the client answered the target (the runner
/// and the browser host speak TLS, so a working connection always goes back and forth) is logged with who ended it.
/// TLS, tokens and the protocol stay between n8n and the runner or browser host.
/// </summary>
public sealed class PortProxy(SessionManager manager, SupervisorOptions options, ISupervisorLog log)
{
    /// <summary>At most this many connections wait for the session or their target at once; the next is closed at once,
    /// so that a flood of connections does not pile up sign-ins.</summary>
    internal const int MaxWaiting = 64;

    private static readonly TimeSpan TargetPoll = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan AcceptRetry = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan PeerLogInterval = TimeSpan.FromSeconds(30);
    private const int MaxPeersRemembered = 256;
    private readonly Dictionary<(string Address, int Port), long> _peersLogged = [];
    private readonly Dictionary<int, (long At, int Left)> _endsLogged = [];
    private int _waiting;
    private int _fullLogged;

    /// <summary>Binds every listener before it returns (a bind failure throws), then serves until ct is cancelled.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var listeners = new List<(TcpListener Listener, PortMap Map)>();
        try
        {
            foreach (var address in options.ListenAddresses)
                foreach (var map in options.Ports)
                {
                    var listener = new TcpListener(IPAddress.Parse(address), map.ListenPort);
                    listeners.Add((listener, map));
                    listener.Start();
                }
            await Task.WhenAll(listeners.Select(l => AcceptAsync(l.Listener, l.Map, ct)));
        }
        finally
        {
            foreach (var (listener, _) in listeners) listener.Stop();
        }
    }

    private async Task AcceptAsync(TcpListener listener, PortMap map, CancellationToken ct)
    {
        while (true)
        {
            Socket client;
            try
            {
                client = await listener.AcceptSocketAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (SocketException e)
            {
                log.Failure(null, $"Accepting a connection on port {map.ListenPort} failed: {e.Message}");
                try
                {
                    // A repeating error must not spin or flood the log.
                    await Task.Delay(AcceptRetry, manager.Time, ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                continue;
            }
            try
            {
                client.NoDelay = true;
            }
            catch (SocketException)
            {
                // The client reset the connection before it was accepted (a scanner or a TCP health check).
                client.Dispose();
                LogEnd(map, $"A connection to port {map.ListenPort} was reset by the client before it was accepted.");
                continue;
            }
            var address = PeerAddress(client);
            LogPeer(address, map);

            if (Interlocked.Increment(ref _waiting) > MaxWaiting)
            {
                Interlocked.Decrement(ref _waiting);
                if (Interlocked.Exchange(ref _fullLogged, 1) == 0)
                    log.Failure(null, $"{MaxWaiting} connections already wait for the session; further connections are closed until fewer wait.");
                client.Dispose();
                continue;
            }
            _ = ServeAsync(client, address, map, ct);
        }
    }

    // Who connected: behind the proxy the runner and the browser host see every peer as 127.0.0.1. One line per address
    // and port per PeerLogInterval; the memory of what was logged is cleared before it holds more than
    // MaxPeersRemembered entries, so that many addresses cannot make it grow without limit.
    private static string PeerAddress(Socket client)
    {
        try
        {
            return (client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "an unknown address";
        }
        catch (Exception e) when (e is SocketException or ObjectDisposedException)
        {
            return "an unknown address";
        }
    }

    private void LogPeer(string address, PortMap map)
    {
        lock (_peersLogged)
        {
            var key = (address, map.ListenPort);
            if (_peersLogged.TryGetValue(key, out var at) && manager.Time.GetElapsedTime(at) < PeerLogInterval) return;
            if (_peersLogged.Count >= MaxPeersRemembered) _peersLogged.Clear();
            _peersLogged[key] = manager.Time.GetTimestamp();
        }
        log.Info($"Connection from {address} to port {map.ListenPort}.");
    }

    private async Task ServeAsync(Socket client, string address, PortMap map, CancellationToken ct)
    {
        Socket? target = null;
        var arrived = manager.Time.GetTimestamp();
        try
        {
            using var hold = manager.Hold();
            try
            {
                target = await WaitForTargetAsync(client, map, ct);
            }
            finally
            {
                Interlocked.Decrement(ref _waiting);
                Volatile.Write(ref _fullLogged, 0);
            }
            if (target is null) return;
            var passed = manager.Time.GetTimestamp();
            var exchange = new Exchange(manager.Time, TargetName(map));
            await PipeAsync(client, target, exchange, ct);
            var ended = exchange.EndedBy is null ? manager.Time.GetTimestamp() : exchange.EndedAt;
            if (!exchange.ClientAnswered && !ct.IsCancellationRequested)
                LogEnd(map, $"A connection from {address} to port {map.ListenPort} ended before " +
                    (exchange.FromTarget == 0 ? $"the {exchange.Target} answered" : $"the client answered the {exchange.Target}") +
                    $": {exchange.EndedBy ?? "it was stopped"} {Seconds(passed, ended)} s after it was passed to the {exchange.Target}, " +
                    $"{Seconds(arrived, ended)} s after it arrived; {Bytes(exchange.FromClient)} came from the client and " +
                    $"{(exchange.FromTarget == 0 ? "none" : exchange.FromTarget.ToString(CultureInfo.InvariantCulture))} from the {exchange.Target}.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            log.Failure(null, $"A connection to port {map.ListenPort} failed: {e.Message}");
        }
        finally
        {
            client.Dispose();
            target?.Dispose();
        }
    }

    // The session, then a connection to the target, within ReadySeconds. Null when the connection is to be closed. A
    // failed sign-in has been recorded with its reason by the manager; only a target that never listened is logged here.
    private async Task<Socket?> WaitForTargetAsync(Socket client, PortMap map, CancellationToken ct)
    {
        using var ready = new CancellationTokenSource(TimeSpan.FromSeconds(options.ReadySeconds), manager.Time);
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct, ready.Token);
        var sessionReady = false;
        try
        {
            await manager.EnsureAsync(wait.Token);
            sessionReady = true;
            return await ConnectTargetAsync(map.TargetPort, wait.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            if (sessionReady && manager.HasOpenConnection)
            {
                // The bot user is signed in, but the program did not start in its session: the last failure says
                // which program, and the log that says why.
                var program = TargetName(map);
                var file = program == "runner" ? "runner.out.log" : "browser.err.log";
                await manager.RecordTargetFailureAsync(
                    $"Nothing listened on 127.0.0.1:{map.TargetPort} within {options.ReadySeconds} s: the {program} did not start in " +
                    $"{options.User}'s session; read %ProgramData%\\RPA Runner\\logs\\{file}. The connection to port {map.ListenPort} is closed.");
            }
            else
                log.Failure(SessionFailure.Timeout, $"No session within {options.ReadySeconds} s; the connection to port {map.ListenPort} is closed.");
            return null;
        }
        catch (SessionException)
        {
            return null; // the manager has recorded why, at most once per 30 s for the same failure
        }
    }

    private async Task<Socket> ConnectTargetAsync(int port, CancellationToken ct)
    {
        while (true)
        {
            // The session went away while this connection waited (its Remote Desktop connection ended): it needs one
            // again, and fails with the sign-in's reason when there is none.
            if (!manager.HasOpenConnection) await manager.EnsureAsync(ct);
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), ct);
                return socket;
            }
            catch (SocketException)
            {
                socket.Dispose();
            }
            catch
            {
                socket.Dispose();
                throw;
            }
            await Task.Delay(TargetPoll, manager.Time, ct);
        }
    }

    // The runner's port comes first in install.json.
    private string TargetName(PortMap map) => map == options.Ports[0] ? "runner" : "browser host";

    private string Seconds(long from, long to) =>
        manager.Time.GetElapsedTime(from, to).TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture);

    private static string Bytes(long count) => count switch
    {
        0 => "no byte",
        1 => "1 byte",
        _ => $"{count.ToString(CultureInfo.InvariantCulture)} bytes",
    };

    // One line per port per PeerLogInterval; the next line written counts the ones left out. A port's lines share one
    // limit, so that a flood of short connections cannot fill the log.
    private void LogEnd(PortMap map, string message)
    {
        int left;
        lock (_endsLogged)
        {
            if (_endsLogged.TryGetValue(map.ListenPort, out var last) && manager.Time.GetElapsedTime(last.At) < PeerLogInterval)
            {
                _endsLogged[map.ListenPort] = last with { Left = last.Left + 1 };
                return;
            }
            left = last.Left;
            _endsLogged[map.ListenPort] = (manager.Time.GetTimestamp(), 0);
        }
        log.Failure(null, left == 0 ? message
            : $"{message} ({left} more such {(left == 1 ? "connection" : "connections")} since the last such line)");
    }

    private static async Task PipeAsync(Socket client, Socket target, Exchange exchange, CancellationToken ct)
    {
        using var broken = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // The client may half-close and still read the answer; a connection lives no longer than its target, so a
        // client that stays open and silent cannot keep the session signed in.
        await Task.WhenAll(CopyAsync(client, target, broken, exchange, fromClient: true),
            CopyAsync(target, client, broken, exchange, fromClient: false));
    }

    // Copies until the source ends, then passes the end on (from the target, it ends the other direction too). A reset
    // or a stop ends both directions. The first end is noted in exchange.
    private static async Task CopyAsync(Socket from, Socket to, CancellationTokenSource broken, Exchange exchange, bool fromClient)
    {
        var (source, other) = fromClient ? ("client", exchange.Target) : (exchange.Target, "client");
        var buffer = new byte[16 * 1024];
        var sending = false;
        try
        {
            int read;
            while ((read = await from.ReceiveAsync(buffer, SocketFlags.None, broken.Token)) > 0)
            {
                exchange.Received(fromClient, read);
                var pending = buffer.AsMemory(0, read);
                sending = true;
                while (!pending.IsEmpty) pending = pending[await to.SendAsync(pending, SocketFlags.None, broken.Token)..];
                sending = false;
            }
            exchange.Ended($"the {source} closed it");
            to.Shutdown(SocketShutdown.Send);
            if (!fromClient) broken.Cancel();
        }
        catch (Exception e) when (e is SocketException or OperationCanceledException or ObjectDisposedException)
        {
            if (e is SocketException) exchange.Ended(sending ? $"the {other} reset it" : $"the {source} reset it");
            broken.Cancel();
        }
    }

    // What passed through one connection: the bytes each way, whether the client sent anything after the target's
    // first bytes, and who ended it first.
    private sealed class Exchange(TimeProvider time, string target)
    {
        private long _fromClient;
        private long _fromTarget;
        private int _clientAnswered;
        private string? _endedBy;

        public string Target => target;
        public long FromClient => Interlocked.Read(ref _fromClient);
        public long FromTarget => Interlocked.Read(ref _fromTarget);
        public bool ClientAnswered => Volatile.Read(ref _clientAnswered) == 1;
        public string? EndedBy => Volatile.Read(ref _endedBy);
        public long EndedAt { get; private set; }

        // The target's bytes are counted before they are passed on, so a client's reply always finds them counted.
        public void Received(bool fromClient, int count)
        {
            if (!fromClient)
            {
                Interlocked.Add(ref _fromTarget, count);
                return;
            }
            if (FromTarget > 0) Volatile.Write(ref _clientAnswered, 1);
            Interlocked.Add(ref _fromClient, count);
        }

        public void Ended(string by)
        {
            var at = time.GetTimestamp();
            if (Interlocked.CompareExchange(ref _endedBy, by, null) is null) EndedAt = at;
        }
    }
}
