using System.Text.Json;

namespace Rpa.Supervisor.Core;

/// <summary>
/// Owns the bot user's session. A connection that needs it calls EnsureAsync: the first signs the user in, later ones
/// reuse the session while it is Active. A session of the user that the supervisor did not create (a person signed
/// in as the bot user) is never signed out or taken over; EnsureAsync refuses with UserSignedIn instead. The session is
/// signed out when no Hold has been taken for IdleSeconds, when its Remote Desktop connection closes, and on StopAsync.
/// The state file names the session the supervisor created, so that after a restart it signs its own stale session
/// out and still leaves a person's alone. The password never passes through here.
/// </summary>
public sealed class SessionManager
{
    // Attempts after a Timeout or a HostExited start at least this far apart: right after boot the Remote Desktop
    // service refuses at once, and the attempts must not spin.
    private static readonly TimeSpan RetrySpacing = TimeSpan.FromSeconds(2);
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
            if (_stopping) throw new InvalidOperationException("The RPA Supervisor is stopping.");
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
            var started = Time.GetTimestamp();
            try
            {
                var connection = await _host.ConnectAsync(_options.User, attempt.Token);
                if (await AdoptAsync(connection)) return;
                await SignOutLeftoverAsync();
                last = new SessionException(SessionFailure.HostExited,
                    $"Session {connection.SessionId} of the Remote Desktop connection is not a session of {_options.User}.");
            }
            catch (SessionException e) when (e.Reason is SessionFailure.Timeout or SessionFailure.HostExited)
            {
                await SignOutLeftoverAsync();
                last = e;
            }
            catch (SessionException e) when (e.Reason is SessionFailure.WrongPassword or SessionFailure.PasswordExpired)
            {
                // Another attempt with the same password could lock the account out.
                await SignOutLeftoverAsync();
                _blocked = new SessionException(e.Reason,
                    $"{e.Message} No further sign-in is tried until the RPA Supervisor service is restarted.");
                throw Fail(_blocked);
            }
            catch (SessionException e)
            {
                await SignOutLeftoverAsync();
                throw Fail(e);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                await SignOutLeftoverAsync();
                throw Fail(last ?? new SessionException(SessionFailure.Timeout,
                    $"{_options.User} was not signed in within {_options.ReadySeconds} s."));
            }
            catch (Exception)
            {
                await SignOutLeftoverAsync();
                throw;
            }

            _log.Info($"Sign-in attempt for {_options.User} failed ({last.Reason}): {last.Message}");
            if (deadline.IsCancellationRequested) throw Fail(last);
            var wait = RetrySpacing - Time.GetElapsedTime(started);
            if (wait <= TimeSpan.Zero) continue;
            try
            {
                await Task.Delay(wait, Time, attempt.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw Fail(last);
            }
        }
    }

    // Before an attempt: signs out what is left of a session of ours and refuses when the user has another session.
    private async Task ClearSessionsAsync()
    {
        if (!await SignOutOursAsync())
            throw new InvalidOperationException(_state.LastFailure);
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
        _log.Info($"Signed {_options.User} in: session {session.Id}.");
        _ = WatchAsync(connection);
        StartIdleClock();
        return true;
    }

    // Before an attempt the user had no session, so a session listed after a failed attempt was made by that attempt.
    private async Task SignOutLeftoverAsync()
    {
        if (_sessions.ForUser(_options.User).FirstOrDefault() is not { } left) return;
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
                var message = $"Signing {_options.User} out of session {id} failed: {e.Message} It is tried again on the next connection.";
                Save(_state with { LastFailure = message });
                _log.Failure(null, message);
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

    private SessionException Fail(SessionException e)
    {
        Save(_state with { LastFailure = $"{e.Reason}: {e.Message}" });
        _log.Failure(e.Reason, e.Message);
        return new SessionException(e.Reason, e.Message);
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
