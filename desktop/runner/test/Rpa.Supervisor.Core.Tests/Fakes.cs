using Microsoft.Extensions.Time.Testing;

namespace Rpa.Supervisor.Core.Tests;

/// <summary>The machine's sessions, in memory. Events is shared with FakeRdpHost so tests can check the order of
/// sign-outs and sign-ins.</summary>
public sealed class FakeSessions(List<string> events) : ISessions
{
    private readonly List<SessionInfo> _sessions = [];
    private readonly List<uint> _signOuts = [];

    /// <summary>This many of the next sign-outs fail.</summary>
    public int FailSignOuts { get; set; }

    public IReadOnlyList<uint> SignOuts { get { lock (_signOuts) return _signOuts.ToArray(); } }

    public void Add(SessionInfo session) { lock (_sessions) _sessions.Add(session); }

    public IReadOnlyList<SessionInfo> All { get { lock (_sessions) return _sessions.ToArray(); } }

    public IReadOnlyList<SessionInfo> ForUser(string user)
    {
        lock (_sessions) return _sessions.Where(s => s.User == user).ToArray();
    }

    public Task SignOutAsync(uint sessionId, CancellationToken ct)
    {
        lock (_signOuts) _signOuts.Add(sessionId);
        lock (events) events.Add($"signout {sessionId}");
        if (FailSignOuts > 0)
        {
            FailSignOuts--;
            throw new InvalidOperationException($"the fake could not sign session {sessionId} out");
        }
        lock (_sessions) _sessions.RemoveAll(s => s.Id == sessionId);
        return Task.CompletedTask;
    }

    /// <summary>Waits until count sign-outs were asked for (background sign-outs in the proxy tests).</summary>
    public async Task WaitForSignOutsAsync(int count)
    {
        for (var i = 0; i < 500 && SignOuts.Count < count; i++) await Task.Delay(10);
        Assert.Equal(count, SignOuts.Count);
    }
}

/// <summary>Signs a user in by adding an Active session to FakeSessions, or fails as Outcomes says.</summary>
public sealed class FakeRdpHost(FakeSessions sessions, TimeProvider time, List<string> events) : IRdpHost
{
    private uint _nextId = 10;
    private int _calls;

    /// <summary>The outcome of each next attempt: a failure, or null for a sign-in. Empty: every attempt signs in.</summary>
    public Queue<SessionFailure?> Outcomes { get; } = new();

    /// <summary>When set, an attempt fails with this reason once Outcomes is empty.</summary>
    public SessionFailure? AlwaysFail { get; set; }

    /// <summary>How long each attempt takes (advances the fake time).</summary>
    public TimeSpan AttemptDuration { get; set; }

    /// <summary>When set, each attempt waits for it before it does anything else.</summary>
    public TaskCompletionSource? Gate { get; set; }

    /// <summary>This many of the next sign-ins return a connection that has already closed (its host ended as the
    /// session became Active).</summary>
    public int ClosedOnReturn { get; set; }

    /// <summary>When set, a failed attempt leaves a session in this state behind: Disconnected as a Remote Desktop
    /// client that times out after the session was made can, Active as a person who signs in during the attempt.</summary>
    public SessionState? LeaveSessionOnFailure { get; set; }

    public int Calls => Volatile.Read(ref _calls);
    public List<FakeConnection> Connections { get; } = [];

    public async Task<IRdpConnection> ConnectAsync(string user, CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        lock (events) events.Add("connect");
        if (Gate is { } gate) await gate.Task.WaitAsync(ct);
        if (AttemptDuration > TimeSpan.Zero) ((FakeTimeProvider)time).Advance(AttemptDuration);
        var outcome = Outcomes.Count > 0 ? Outcomes.Dequeue() : AlwaysFail;
        var id = _nextId++;
        if (outcome is { } failure)
        {
            if (LeaveSessionOnFailure is { } state) sessions.Add(new SessionInfo(id, user, state, time.GetUtcNow()));
            throw new SessionException(failure, $"the fake failed with {failure}");
        }
        sessions.Add(new SessionInfo(id, user, SessionState.Active, time.GetUtcNow()));
        var connection = new FakeConnection(id);
        lock (Connections) Connections.Add(connection);
        if (ClosedOnReturn > 0)
        {
            ClosedOnReturn--;
            connection.Drop();
        }
        return connection;
    }
}

/// <summary>The Remote Desktop service and its port: ready unless a test says otherwise.</summary>
public sealed class FakeRemoteDesktop : IRemoteDesktopService
{
    /// <summary>The answers of the next checks; when it is empty, the port is ready.</summary>
    public Queue<string?> Problems { get; } = new();

    /// <summary>When set, every check after Problems is empty answers this.</summary>
    public string? AlwaysProblem { get; set; }

    public int Checks { get; private set; }

    public string? Problem()
    {
        Checks++;
        return Problems.Count > 0 ? Problems.Dequeue() : AlwaysProblem;
    }
}

public sealed class FakeConnection(uint sessionId) : IRdpConnection
{
    private readonly TaskCompletionSource _closed = new();

    public uint SessionId => sessionId;
    public Task Closed => _closed.Task;
    public bool Disposed { get; private set; }

    /// <summary>The connection drops (the host process died or the client was disconnected).</summary>
    public void Drop() => _closed.TrySetResult();

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        _closed.TrySetResult();
        return ValueTask.CompletedTask;
    }
}

public sealed class RecordingLog : ISupervisorLog
{
    private readonly List<(SessionFailure? Reason, string Message)> _failures = [];
    private readonly List<string> _infos = [];

    public IReadOnlyList<(SessionFailure? Reason, string Message)> Failures { get { lock (_failures) return _failures.ToArray(); } }
    public IReadOnlyList<string> Infos { get { lock (_infos) return _infos.ToArray(); } }

    public void Info(string message) { lock (_infos) _infos.Add(message); }
    public void Failure(SessionFailure? reason, string message) { lock (_failures) _failures.Add((reason, message)); }
}
