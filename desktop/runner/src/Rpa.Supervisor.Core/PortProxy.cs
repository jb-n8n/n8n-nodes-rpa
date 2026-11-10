using System.Net;
using System.Net.Sockets;

namespace Rpa.Supervisor.Core;

/// <summary>
/// Listens on each of ListenAddresses for each PortMap. For each connection it holds the session, waits for
/// EnsureAsync and then for something to listen on 127.0.0.1 at the map's target port (together at most ReadySeconds),
/// and passes bytes both ways without reading them. Bytes the client sends while it waits stay in the socket and are
/// passed on in order. When the client ends its side, the end is passed on and the target's answer still flows back;
/// when the target ends, the connection ends.
/// TLS, tokens and the protocol stay between n8n and the runner or browser host.
/// </summary>
public sealed class PortProxy(SessionManager manager, SupervisorOptions options, ISupervisorLog log)
{
    /// <summary>At most this many connections wait for the session or their target at once; the next is closed at once,
    /// so that a flood of connections does not pile up sign-ins.</summary>
    internal const int MaxWaiting = 64;

    private static readonly TimeSpan TargetPoll = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan AcceptRetry = TimeSpan.FromMilliseconds(500);
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
                continue;
            }

            if (Interlocked.Increment(ref _waiting) > MaxWaiting)
            {
                Interlocked.Decrement(ref _waiting);
                if (Interlocked.Exchange(ref _fullLogged, 1) == 0)
                    log.Failure(null, $"{MaxWaiting} connections already wait for the session; further connections are closed until fewer wait.");
                client.Dispose();
                continue;
            }
            _ = ServeAsync(client, map, ct);
        }
    }

    private async Task ServeAsync(Socket client, PortMap map, CancellationToken ct)
    {
        Socket? target = null;
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
            if (target is not null) await PipeAsync(client, target, ct);
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

    // The session, then a connection to the target, within ReadySeconds. Null when the connection is to be closed.
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
            log.Failure(sessionReady ? null : SessionFailure.Timeout, sessionReady
                ? $"Nothing listened on 127.0.0.1:{map.TargetPort} within {options.ReadySeconds} s; the connection to port {map.ListenPort} is closed."
                : $"No session within {options.ReadySeconds} s; the connection to port {map.ListenPort} is closed.");
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

    private static async Task PipeAsync(Socket client, Socket target, CancellationToken ct)
    {
        using var broken = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // The client may half-close and still read the answer; a connection lives no longer than its target, so a
        // client that stays open and silent cannot keep the session signed in.
        await Task.WhenAll(CopyAsync(client, target, broken, endsBoth: false), CopyAsync(target, client, broken, endsBoth: true));
    }

    // Copies until the source ends, then passes the end on (and with endsBoth, ends the other direction too). A reset
    // or a stop ends both directions.
    private static async Task CopyAsync(Socket from, Socket to, CancellationTokenSource broken, bool endsBoth)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            int read;
            while ((read = await from.ReceiveAsync(buffer, SocketFlags.None, broken.Token)) > 0)
            {
                var pending = buffer.AsMemory(0, read);
                while (!pending.IsEmpty) pending = pending[await to.SendAsync(pending, SocketFlags.None, broken.Token)..];
            }
            to.Shutdown(SocketShutdown.Send);
            if (endsBoth) broken.Cancel();
        }
        catch (Exception e) when (e is SocketException or OperationCanceledException or ObjectDisposedException)
        {
            broken.Cancel();
        }
    }
}
