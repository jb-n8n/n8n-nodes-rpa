using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text.Json;

namespace Rpa.Supervisor.Core;

/// <summary>
/// Owns the bot user's session. A connection that needs it calls EnsureAsync: the first signs the user in, later ones
/// reuse the session while it is Active. The supervisor takes a session as its own in two cases only: on a sign-in,
/// the session its Remote Desktop connection reports; after a failed attempt, a half-made session that is inferred to
/// be the attempt's (see SignOutLeftoverAsync). It does not sign out or take over any other session of the user (a
/// person signed in as the bot user); EnsureAsync refuses with UserSignedIn instead. Its own session is signed out
/// when no Hold has been taken for IdleSeconds, when its Remote Desktop connection closes, and on StopAsync. The state
/// file names that session, so that after a restart the supervisor signs its own stale session out and still leaves a
/// person's alone. The password never passes through here.
/// </summary>
public sealed class SessionManager
{
    // Attempts after a Timeout or a HostExited start at least this far apart: right after boot the Remote Desktop
    // service refuses at once, and the attempts must not spin.
    private static readonly TimeSpan RetrySpacing = TimeSpan.FromSeconds(2);
    // A failure that repeats (a refused connection after another) is logged and written at most this often.
    private static readonly TimeSpan RepeatInterval = TimeSpan.FromSeconds(30);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ISessions _sessions;
    private readonly IRdpHost _host;
    private readonly SupervisorOptions _options;
    private readonly ISupervisorLog _log;

    private readonly SemaphoreSlim _lock = new(1, 1); // around create and sign-out
    private readonly object _gate = new(); // around the hold count and the idle timer
    private int _holds;
    private long _idleGeneration;
    private ITimer? _idleTimer;

    private State _state; // written under _lock only
    private IRdpConnection? _connection;
    private SessionException? _blocked;
    private bool _stopping;
    private long? _failureRecordedAt;

    public SessionManager(ISessions sessions, IRdpHost host, SupervisorOptions options, ISupervisorLog log, TimeProvider time)
    {
        _sessions = sessions;
        _host = host;
        _options = options;
        _log = log;
        Time = time;
        _state = Load();
    }

    /// <summary>The clock for the idle time and the waits; the proxy uses it too.</summary>
    internal TimeProvider Time { get; }

    /// <summary>The last sign-in or sign-out failure ("Reason: message"), cleared by a successful sign-in. Also in the
    /// state file as lastFailure.</summary>
    public string? LastFailure => _state.LastFailure;

    /// <summary>Returns when a session the supervisor created exists and is Active, or throws SessionException.</summary>
    public async Task EnsureAsync(CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            if (_stopping) throw new SessionException(SessionFailure.HostExited, "The RPA Supervisor is stopping.");
            if (_blocked is { } blocked) throw Fail(blocked);
            if (_connection is { Closed.IsCompleted: false }
                && _sessions.ForUser(_options.User).Any(s => IsOurs(s) && s.State == SessionState.Active))
                return;
            await SignInAsync(ct);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>One per proxied connection. While any is held the session is kept; when the last is released the idle
    /// clock starts.</summary>
    public IDisposable Hold()
    {
        lock (_gate)
        {
            _holds++;
            _idleGeneration++;
            _idleTimer?.Dispose();
            _idleTimer = null;
        }
        return new Holder(this);
    }

    /// <summary>Signs the session the supervisor created out. Later calls to EnsureAsync are refused.</summary>
    public async Task StopAsync()
    {
        await _lock.WaitAsync();
        try
        {
            _stopping = true;
            lock (_gate)
            {
                _idleGeneration++;
                _idleTimer?.Dispose();
                _idleTimer = null;
            }
            await SignOutOursAsync();
        }
        finally
        {
            _lock.Release();
        }
    }

    // Called under _lock with no usable session of ours.
    private async Task SignInAsync(CancellationToken ct)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(_options.ReadySeconds), Time);
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        SessionException? last = null;
        while (true)
        {
            await ClearSessionsAsync();
            var startedAt = Time.GetUtcNow();
            var started = Time.GetTimestamp();
            Exception failure;
            try
            {
                var connection = await _host.ConnectAsync(_options.User, attempt.Token);
                // On success the supervisor adopts the session its connection reports.
                if (await AdoptAsync(connection)) return;
                failure = new SessionException(SessionFailure.HostExited,
                    $"Session {connection.SessionId} of the Remote Desktop connection is not a session of {_options.User}.");
            }
            catch (Exception e)
            {
                failure = e;
            }
            last = await AttemptFailedAsync(failure, startedAt, last, ct);

            _log.Info($"Sign-in attempt for {_options.User} failed ({last.Reason}): {last.Message}");
            if (deadline.IsCancellationRequested) throw Fail(last);
            var wait = RetrySpacing - Time.GetElapsedTime(started);
            if (wait <= TimeSpan.Zero) continue;
            try
            {
                await Task.Delay(wait, Time, attempt.Token);
            }
            catch (OperationCanceledException)
            {
                // Recorded also when the caller gave up first, so the reason the sign-in kept failing is not lost.
                var reason = Fail(last);
                if (!ct.IsCancellationRequested) throw reason;
                throw;
            }
        }
    }

    // After a failed attempt: signs out a session the attempt may have left, then returns the failure when another
    // attempt may follow, or throws.
    private async Task<SessionException> AttemptFailedAsync(Exception failure, DateTimeOffset startedAt,
        SessionException? last, CancellationToken ct)
    {
        // WrongPassword, PasswordExpired, NotAllowed and NoPassword fail before a session exists.
        if (failure is not SessionException { Reason: not (SessionFailure.Timeout or SessionFailure.HostExited) })
            await SignOutLeftoverAsync(startedAt);
        switch (failure)
        {
            case SessionException { Reason: SessionFailure.Timeout or SessionFailure.HostExited } retry:
                return retry;
            case SessionException { Reason: SessionFailure.WrongPassword or SessionFailure.PasswordExpired } e:
                // Another attempt with the same password could lock the account out.
                _blocked = new SessionException(e.Reason,
                    $"{e.Message} No further sign-in is tried until the RPA Supervisor service is restarted.");
                throw Fail(_blocked);
            case SessionException e:
                throw Fail(e);
            case OperationCanceledException when !ct.IsCancellationRequested:
                throw Fail(last ?? new SessionException(SessionFailure.Timeout,
                    $"{_options.User} was not signed in within {_options.ReadySeconds} s."));
            default:
                // The caller gave up, or something unexpected failed: keep the reason the sign-in kept failing for.
                if (last is not null) Fail(last);
                ExceptionDispatchInfo.Throw(failure);
                throw new UnreachableException();
        }
    }

    // Before an attempt: signs out what is left of a session of ours and refuses when the user has another session.
    private async Task ClearSessionsAsync()
    {
        if (!await SignOutOursAsync())
            throw new SessionException(SessionFailure.HostExited, _state.LastFailure ?? "Signing the session out failed.");
        if (_sessions.ForUser(_options.User).FirstOrDefault() is { } other)
            throw Fail(new SessionException(SessionFailure.UserSignedIn,
                $"{_options.User} has a session the RPA Supervisor did not create (session {other.Id}, {other.State}). " +
                "It is left alone and the connection is refused until that session is signed out."));
    }

    private async Task<bool> AdoptAsync(IRdpConnection connection)
    {
        var session = _sessions.ForUser(_options.User).FirstOrDefault(s => s.Id == connection.SessionId);
        if (session is null)
        {
            await DisposeQuietlyAsync(connection);
            return false;
        }
        _connection = connection;
        Save(_state with { SessionId = session.Id, LogonTime = session.LogonTime, LastFailure = null });
        _failureRecordedAt = null;
        _log.Info($"Signed {_options.User} in: session {session.Id}.");
        _ = WatchAsync(connection);
        StartIdleClock();
        return true;
    }

    // Called after a failure that can leave a half-made session (Timeout, HostExited, a cancelled attempt, an
    // unexpected exception). Just before the attempt the user had no session. A session listed now is inferred to be
    // the attempt's, and signed out, only when it is the user's only session, it began at or after the attempt started,
    // and it is not Active (nobody connected to a desktop is signed out). Anything else is left alone and logged; the
    // next check refuses it with UserSignedIn.
    private async Task SignOutLeftoverAsync(DateTimeOffset startedAt)
    {
        var listed = _sessions.ForUser(_options.User);
        if (listed.Count == 0) return;
        if (listed is not [{ State: not SessionState.Active } left] || left.LogonTime < startedAt)
        {
            _log.Info($"After the failed sign-in {_options.User} has a session the RPA Supervisor does not take as its own " +
                $"(session {listed[0].Id}, {listed[0].State}); it is left alone.");
            return;
        }
        Save(_state with { SessionId = left.Id, LogonTime = left.LogonTime });
        _log.Info($"Session {left.Id} was left by a failed sign-in; signing it out.");
        await SignOutOursAsync();
    }

    // Under _lock. Drops our connection and signs our session out if it is still listed. A failed sign-out is logged,
    // the session stays named in the state file, and false is returned: the next EnsureAsync tries again.
    private async Task<bool> SignOutOursAsync()
    {
        var connection = _connection;
        _connection = null;
        try
        {
            if (_state.SessionId is not { } id) return true;
            if (!_sessions.ForUser(_options.User).Any(IsOurs))
            {
                Save(_state with { SessionId = null, LogonTime = null });
                return true;
            }
            try
            {
                await _sessions.SignOutAsync(id, CancellationToken.None);
            }
            catch (Exception e)
            {
                Record(null, $"Signing {_options.User} out of session {id} failed: {e.Message} It is tried again on the next connection.");
                return false;
            }
            Save(_state with { SessionId = null, LogonTime = null });
            _log.Info($"Signed {_options.User} out: session {id}.");
            return true;
        }
        finally
        {
            if (connection is not null) await DisposeQuietlyAsync(connection);
        }
    }

    private async Task WatchAsync(IRdpConnection connection)
    {
        await Task.WhenAny(connection.Closed);
        await SignOutInBackgroundAsync(() => _connection == connection,
            $"The Remote Desktop connection of session {connection.SessionId} closed; signing {_options.User} out.");
    }

    private void StartIdleClock()
    {
        long generation;
        lock (_gate)
        {
            if (_holds > 0) return;
            generation = ++_idleGeneration;
            _idleTimer?.Dispose();
            _idleTimer = _options.IdleSeconds > 0
                ? Time.CreateTimer(_ => _ = SignOutIdleAsync(generation), null, TimeSpan.FromSeconds(_options.IdleSeconds),
                    Timeout.InfiniteTimeSpan)
                : null;
        }
        if (_options.IdleSeconds <= 0) _ = SignOutIdleAsync(generation);
    }

    private Task SignOutIdleAsync(long generation) =>
        SignOutInBackgroundAsync(() => { lock (_gate) return generation == _idleGeneration && _holds == 0; },
            $"No connection for {_options.IdleSeconds} s; signing {_options.User} out.");

    private async Task SignOutInBackgroundAsync(Func<bool> stillWanted, string why)
    {
        await _lock.WaitAsync();
        try
        {
            if (!stillWanted() || (_connection is null && _state.SessionId is null)) return;
            _log.Info(why);
            await SignOutOursAsync();
        }
        catch (Exception e)
        {
            _log.Failure(null, $"Signing {_options.User} out failed: {e.Message}");
        }
        finally
        {
            _lock.Release();
        }
    }

    private void Release()
    {
        lock (_gate) _holds--;
        StartIdleClock();
    }

    private bool IsOurs(SessionInfo session) => session.Id == _state.SessionId && session.LogonTime == _state.LogonTime;

    // Records a sign-in failure and returns a fresh exception to throw.
    private SessionException Fail(SessionException e)
    {
        Record(e.Reason, e.Message);
        return new SessionException(e.Reason, e.Message);
    }

    // Records a failure in LastFailure, the state file and the log. The same failure again is recorded at most once per
    // RepeatInterval, so refused connections do not write without limit.
    private void Record(SessionFailure? reason, string message)
    {
        var text = reason is { } r ? $"{r}: {message}" : message;
        if (text == _state.LastFailure && _failureRecordedAt is { } at && Time.GetElapsedTime(at) < RepeatInterval) return;
        _failureRecordedAt = Time.GetTimestamp();
        Save(_state with { LastFailure = text });
        _log.Failure(reason, message);
    }

    private async Task DisposeQuietlyAsync(IRdpConnection connection)
    {
        try
        {
            await connection.DisposeAsync();
        }
        catch (Exception e)
        {
            _log.Failure(null, $"Closing the Remote Desktop connection of session {connection.SessionId} failed: {e.Message}");
        }
    }

    private State Load()
    {
        if (_options.StateFile == "" || !File.Exists(_options.StateFile)) return new State();
        try
        {
            return JsonSerializer.Deserialize<State>(File.ReadAllText(_options.StateFile), Json) ?? new State();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Failure(null, $"The state file {_options.StateFile} could not be read and is ignored: {e.Message}");
            return new State();
        }
    }

    private void Save(State state)
    {
        _state = state;
        if (_options.StateFile == "") return;
        try
        {
            var temporary = _options.StateFile + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(state, Json));
            File.Move(temporary, _options.StateFile, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Failure(null, $"The state file {_options.StateFile} could not be written: {e.Message}");
        }
    }

    /// <summary>The state file's content: the session the supervisor created, and the last failure.</summary>
    private sealed record State(uint? SessionId = null, DateTimeOffset? LogonTime = null, string? LastFailure = null);

    private sealed class Holder(SessionManager manager) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0) manager.Release();
        }
    }
}
