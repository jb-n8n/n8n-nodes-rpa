using System.Text.Json.Nodes;
using Microsoft.Extensions.Time.Testing;

namespace Rpa.Supervisor.Core.Tests;

public sealed class SessionManagerTests : IDisposable
{
    private const string Bot = "rpabot";
    private readonly string _dir = Directory.CreateTempSubdirectory("rpa-supervisor-").FullName;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));
    private readonly List<string> _events = [];
    private readonly FakeSessions _sessions;
    private readonly FakeRdpHost _host;
    private readonly RecordingLog _log = new();
    private readonly FakeRemoteDesktop _remoteDesktop = new();

    public SessionManagerTests()
    {
        _sessions = new FakeSessions(_events);
        _host = new FakeRdpHost(_sessions, _time, _events);
    }

    public void Dispose() => Directory.Delete(_dir, true);

    private string StateFile => Path.Combine(_dir, "supervisor-state.json");

    private SessionManager Manager(int idleSeconds = 15, int readySeconds = 45) =>
        new(_sessions, _host, _remoteDesktop, new SupervisorOptions(Bot, [new PortMap(8765, 18765)], ["127.0.0.1"], idleSeconds,
            readySeconds, StateFile), _log, _time);

    private void WriteState(uint sessionId, DateTimeOffset logonTime) =>
        File.WriteAllText(StateFile, new JsonObject { ["sessionId"] = sessionId, ["logonTime"] = logonTime }.ToJsonString());

    private JsonNode ReadState() => JsonNode.Parse(File.ReadAllText(StateFile))!;

    // Advances the fake time in steps while the task runs, for waits between attempts.
    private async Task<T> Drive<T>(Task<T> task)
    {
        for (var i = 0; i < 1000 && !task.IsCompleted; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(1);
        }
        return await task;
    }

    private static async Task<SessionException> Fails(Func<Task> act) => await Assert.ThrowsAsync<SessionException>(act);

    [Fact]
    public async Task The_first_EnsureAsync_signs_the_user_in_and_records_the_session_in_the_state_file()
    {
        var manager = Manager();
        await manager.EnsureAsync(CancellationToken.None);

        Assert.Equal(1, _host.Calls);
        var session = Assert.Single(_sessions.ForUser(Bot));
        Assert.Equal(SessionState.Active, session.State);
        var state = ReadState();
        Assert.Equal(session.Id, state["sessionId"]!.GetValue<uint>());
        Assert.Equal(session.LogonTime, state["logonTime"]!.GetValue<DateTimeOffset>());
        Assert.Null(manager.LastFailure);
    }

    [Fact]
    public async Task A_second_EnsureAsync_while_a_session_of_ours_is_Active_does_not_connect_again()
    {
        var manager = Manager();
        await manager.EnsureAsync(CancellationToken.None);
        await manager.EnsureAsync(CancellationToken.None);

        Assert.Equal(1, _host.Calls);
        Assert.Empty(_sessions.SignOuts);
    }

    [Fact]
    public async Task Two_EnsureAsync_calls_at_once_make_one_connection()
    {
        var manager = Manager();
        _host.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = manager.EnsureAsync(CancellationToken.None);
        var second = manager.EnsureAsync(CancellationToken.None);
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        _host.Gate.SetResult();
        await Task.WhenAll(first, second);

        Assert.Equal(1, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task A_session_of_the_user_that_the_state_file_does_not_name_is_not_signed_out_and_EnsureAsync_throws_UserSignedIn()
    {
        // A person signed in as the bot user. Session ids are reused, so the state file naming the same id with
        // another logon time does not make it ours.
        var logon = _time.GetUtcNow().AddMinutes(-5);
        _sessions.Add(new SessionInfo(3, Bot, SessionState.Active, logon));
        _sessions.Add(new SessionInfo(4, "someone-else", SessionState.Active, logon));
        WriteState(3, logon.AddHours(-1));
        var manager = Manager();

        var e = await Fails(() => manager.EnsureAsync(CancellationToken.None));

        Assert.Equal(SessionFailure.UserSignedIn, e.Reason);
        Assert.Empty(_sessions.SignOuts);
        Assert.Equal(0, _host.Calls);
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.UserSignedIn);
        Assert.Contains("UserSignedIn", manager.LastFailure);
        Assert.Contains("UserSignedIn", ReadState()["lastFailure"]!.GetValue<string>());

        // Once the person signed out, the next connection gets a session.
        await _sessions.SignOutAsync(3, CancellationToken.None);
        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(1, _host.Calls);
        Assert.Null(manager.LastFailure);
    }

    [Fact]
    public async Task A_session_the_state_file_names_is_signed_out_before_a_new_one_is_made()
    {
        // The supervisor crashed and restarted: its last session is still there, disconnected.
        var logon = _time.GetUtcNow().AddMinutes(-20);
        _sessions.Add(new SessionInfo(7, Bot, SessionState.Disconnected, logon));
        WriteState(7, logon);
        var manager = Manager();

        await manager.EnsureAsync(CancellationToken.None);

        Assert.Equal(["signout 7", "connect"], _events);
        var session = Assert.Single(_sessions.ForUser(Bot));
        Assert.NotEqual(7u, session.Id);
        Assert.Equal(session.Id, ReadState()["sessionId"]!.GetValue<uint>());
    }

    [Fact]
    public async Task With_no_Hold_for_IdleSeconds_the_session_is_signed_out_and_a_Hold_taken_before_that_keeps_it()
    {
        var manager = Manager(idleSeconds: 15);
        await manager.EnsureAsync(CancellationToken.None);
        var id = _sessions.ForUser(Bot)[0].Id;

        _time.Advance(TimeSpan.FromSeconds(14));
        Assert.Empty(_sessions.SignOuts);
        var hold = manager.Hold();
        _time.Advance(TimeSpan.FromMinutes(10));
        Assert.Empty(_sessions.SignOuts);

        hold.Dispose();
        _time.Advance(TimeSpan.FromSeconds(14));
        Assert.Empty(_sessions.SignOuts);
        _time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal([id], _sessions.SignOuts);
        Assert.Empty(_sessions.ForUser(Bot));
        Assert.Null(ReadState()["sessionId"]);
        Assert.True(_host.Connections[0].Disposed);
    }

    [Fact]
    public async Task IdleSeconds_0_signs_out_as_soon_as_the_last_Hold_is_released()
    {
        var manager = Manager(idleSeconds: 0);
        var first = manager.Hold();
        var second = manager.Hold();
        await manager.EnsureAsync(CancellationToken.None);
        var id = _sessions.ForUser(Bot)[0].Id;

        first.Dispose();
        Assert.Empty(_sessions.SignOuts);
        second.Dispose();
        await _sessions.WaitForSignOutsAsync(1);
        Assert.Equal([id], _sessions.SignOuts);
    }

    [Theory]
    [InlineData(SessionFailure.WrongPassword)]
    [InlineData(SessionFailure.PasswordExpired)]
    public async Task WrongPassword_and_PasswordExpired_stop_further_attempts_the_next_EnsureAsync_throws_the_same_reason_without_calling_the_host(SessionFailure reason)
    {
        var manager = Manager();
        _host.Outcomes.Enqueue(reason);

        Assert.Equal(reason, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Equal(reason, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);

        Assert.Equal(1, _host.Calls);
        Assert.Contains(reason.ToString(), manager.LastFailure);
        Assert.Contains(reason.ToString(), ReadState()["lastFailure"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_refusal_that_repeats_is_logged_and_written_once_per_30_s()
    {
        _sessions.Add(new SessionInfo(3, Bot, SessionState.Active, _time.GetUtcNow()));
        var manager = Manager();

        await Fails(() => manager.EnsureAsync(CancellationToken.None));
        File.Delete(StateFile);
        for (var i = 0; i < 20; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(1));
            await Fails(() => manager.EnsureAsync(CancellationToken.None));
        }
        Assert.Single(_log.Failures, f => f.Reason == SessionFailure.UserSignedIn);
        Assert.False(File.Exists(StateFile));

        _time.Advance(TimeSpan.FromSeconds(10));
        await Fails(() => manager.EnsureAsync(CancellationToken.None));
        Assert.Equal(2, _log.Failures.Count(f => f.Reason == SessionFailure.UserSignedIn));
        Assert.True(File.Exists(StateFile));

        // A different failure is recorded at once.
        await _sessions.SignOutAsync(3, CancellationToken.None);
        _host.Outcomes.Enqueue(SessionFailure.NotAllowed);
        Assert.Equal(SessionFailure.NotAllowed, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Contains("NotAllowed", ReadState()["lastFailure"]!.GetValue<string>());
    }

    [Fact]
    public async Task EnsureAsync_tries_again_after_a_Timeout_or_a_HostExited_until_ReadySeconds_have_passed_then_throws_the_last_reason()
    {
        // Right after boot: two failed attempts, then a session.
        var manager = Manager(readySeconds: 45);
        _host.AttemptDuration = TimeSpan.FromSeconds(10);
        _host.Outcomes.Enqueue(SessionFailure.Timeout);
        _host.Outcomes.Enqueue(SessionFailure.HostExited);
        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(3, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
        await manager.StopAsync();

        // Every attempt takes 10 s: attempts at 0, 10, 20, 30 and 40 s, then the last reason.
        var again = new FakeRdpHost(_sessions, _time, []) { AttemptDuration = TimeSpan.FromSeconds(10) };
        again.Outcomes.Enqueue(SessionFailure.Timeout);
        again.AlwaysFail = SessionFailure.HostExited;
        var slow = new SessionManager(_sessions, again, _remoteDesktop, new SupervisorOptions(Bot, [], [], ReadySeconds: 45), _log, _time);
        var started = _time.GetTimestamp();
        Assert.Equal(SessionFailure.HostExited, (await Fails(() => slow.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Equal(5, again.Calls);
        Assert.True(_time.GetElapsedTime(started) >= TimeSpan.FromSeconds(45));

        // Attempts that fail at once are spaced out, not repeated in a tight loop.
        var fast = new FakeRdpHost(_sessions, _time, []) { AlwaysFail = SessionFailure.HostExited };
        var quick = new SessionManager(_sessions, fast, _remoteDesktop, new SupervisorOptions(Bot, [], [], ReadySeconds: 45), _log, _time);
        var e = await Drive(Fails(() => quick.EnsureAsync(CancellationToken.None)));
        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.InRange(fast.Calls, 2, 24);
    }

    [Theory]
    [InlineData(SessionFailure.Timeout)]
    [InlineData(SessionFailure.HostExited)]
    public async Task Timeout_and_HostExited_allow_a_new_attempt_on_the_next_call(SessionFailure reason)
    {
        var manager = Manager(readySeconds: 10);
        _host.AttemptDuration = TimeSpan.FromSeconds(11);
        _host.Outcomes.Enqueue(reason);

        Assert.Equal(reason, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Equal(1, _host.Calls);

        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(2, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task A_session_left_by_a_failed_attempt_is_signed_out_before_the_next_attempt()
    {
        // Without this the left session would look like a person's and every later connection would be refused.
        var manager = Manager();
        _host.AttemptDuration = TimeSpan.FromSeconds(10);
        _host.LeaveSessionOnFailure = SessionState.Disconnected;
        _host.Outcomes.Enqueue(SessionFailure.Timeout);

        await manager.EnsureAsync(CancellationToken.None);

        Assert.Equal(["connect", "signout 10", "connect"], _events);
        Assert.Equal(11u, Assert.Single(_sessions.ForUser(Bot)).Id);
    }

    // Fails the next attempt with Timeout after the given sessions appeared while it ran. The attempt takes longer
    // than the spacing between attempts, so the next check follows at once.
    private async Task<SessionException> FailAttemptWhile(SessionManager manager, params SessionInfo[] appearing)
    {
        _host.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _host.AttemptDuration = TimeSpan.FromSeconds(3);
        _host.Outcomes.Enqueue(SessionFailure.Timeout);
        var ensure = manager.EnsureAsync(CancellationToken.None);
        foreach (var session in appearing) _sessions.Add(session);
        _host.Gate.SetResult();
        return await Fails(() => ensure.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task A_Disconnected_session_that_began_before_the_attempt_is_not_signed_out()
    {
        var manager = Manager();

        var e = await FailAttemptWhile(manager, new SessionInfo(50, Bot, SessionState.Disconnected, _time.GetUtcNow().AddMinutes(-1)));

        Assert.Equal(SessionFailure.UserSignedIn, e.Reason);
        Assert.Empty(_sessions.SignOuts);
        Assert.Single(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task When_the_user_has_two_sessions_after_a_failed_attempt_neither_is_signed_out()
    {
        var manager = Manager();
        var now = _time.GetUtcNow();

        var e = await FailAttemptWhile(manager, new SessionInfo(50, Bot, SessionState.Disconnected, now),
            new SessionInfo(51, Bot, SessionState.Disconnected, now));

        Assert.Equal(SessionFailure.UserSignedIn, e.Reason);
        Assert.Empty(_sessions.SignOuts);
        Assert.Equal(2, _sessions.ForUser(Bot).Count);
    }

    [Theory]
    [InlineData(SessionFailure.Timeout)]
    [InlineData(SessionFailure.WrongPassword)]
    public async Task A_persons_Active_session_that_appears_during_a_failing_attempt_is_not_signed_out(SessionFailure reason)
    {
        // A person signs in as the bot user while an attempt runs, and the attempt then fails.
        var manager = Manager(readySeconds: 45);
        _host.AttemptDuration = TimeSpan.FromSeconds(10);
        _host.LeaveSessionOnFailure = SessionState.Active;
        _host.Outcomes.Enqueue(reason);

        var e = await Fails(() => manager.EnsureAsync(CancellationToken.None));

        Assert.Equal(reason == SessionFailure.Timeout ? SessionFailure.UserSignedIn : reason, e.Reason);
        Assert.Empty(_sessions.SignOuts);
        Assert.Equal(SessionState.Active, Assert.Single(_sessions.ForUser(Bot)).State);
        Assert.Null(ReadState()["sessionId"]);
    }

    [Theory]
    [InlineData("")]
    [InlineData("{ \"sessionId\": 3, damaged")]
    public async Task An_empty_or_damaged_state_file_loads_without_a_throw_and_causes_no_sign_out(string content)
    {
        _sessions.Add(new SessionInfo(3, Bot, SessionState.Disconnected, _time.GetUtcNow()));
        File.WriteAllText(StateFile, content);

        var manager = Manager();

        Assert.Equal(SessionFailure.UserSignedIn, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Empty(_sessions.SignOuts);
        Assert.Contains(_log.Failures, f => f.Reason is null && f.Message.Contains("state file"));
    }

    [Fact]
    public async Task An_attempt_cancelled_by_the_caller_ends_and_the_next_call_connects()
    {
        var manager = Manager();
        _host.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var caller = new CancellationTokenSource();
        var first = manager.EnsureAsync(caller.Token);
        Assert.False(first.IsCompleted);

        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.Empty(_sessions.ForUser(Bot));
        Assert.Null(manager.LastFailure);

        _host.Gate = null;
        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(2, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task When_the_connections_Closed_completes_the_session_is_signed_out_and_the_next_EnsureAsync_connects_again()
    {
        var manager = Manager();
        using var hold = manager.Hold();
        await manager.EnsureAsync(CancellationToken.None);
        var id = _sessions.ForUser(Bot)[0].Id;

        _host.Connections[0].Drop();
        await _sessions.WaitForSignOutsAsync(1);
        Assert.Equal([id], _sessions.SignOuts);

        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(2, _host.Calls);
        Assert.NotEqual(id, Assert.Single(_sessions.ForUser(Bot)).Id);
    }

    [Fact]
    public async Task A_failed_sign_out_is_tried_again_on_the_next_call_and_is_logged()
    {
        var manager = Manager(idleSeconds: 15);
        await manager.EnsureAsync(CancellationToken.None);
        var id = _sessions.ForUser(Bot)[0].Id;
        _sessions.FailSignOuts = 2;

        _time.Advance(TimeSpan.FromSeconds(15));
        Assert.Equal([id], _sessions.SignOuts);
        Assert.Contains(_log.Failures, f => f.Reason is null && f.Message.Contains($"session {id}"));
        Assert.Contains($"session {id}", manager.LastFailure);
        Assert.Equal(id, ReadState()["sessionId"]!.GetValue<uint>());

        // The next call tries again; while it still fails, the connection is refused with a SessionException.
        var e = await Fails(() => manager.EnsureAsync(CancellationToken.None));
        Assert.Contains($"session {id}", e.Message);
        Assert.Equal([id, id], _sessions.SignOuts);
        Assert.Equal(1, _host.Calls);

        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal([id, id, id], _sessions.SignOuts);
        Assert.Equal(2, _host.Calls);
        Assert.NotEqual(id, Assert.Single(_sessions.ForUser(Bot)).Id);
    }

    [Fact]
    public async Task Refused_fails_the_connection_without_a_retry_and_the_next_call_tries_again()
    {
        var manager = Manager(readySeconds: 45);
        _host.Outcomes.Enqueue(SessionFailure.Refused);

        Assert.Equal(SessionFailure.Refused, (await Fails(() => manager.EnsureAsync(CancellationToken.None))).Reason);
        Assert.Equal(1, _host.Calls);

        await manager.EnsureAsync(CancellationToken.None);
        Assert.Equal(2, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
    }

    [Fact]
    public async Task While_the_Remote_Desktop_service_is_not_running_no_attempt_starts_and_it_is_tried_again()
    {
        var manager = Manager(readySeconds: 45);
        _remoteDesktop.StoppedChecks = 2;

        await Drive(manager.EnsureAsync(CancellationToken.None).ContinueWith(_ => 0));

        Assert.Equal(3, _remoteDesktop.Checks);
        Assert.Equal(1, _host.Calls);
        Assert.Single(_sessions.ForUser(Bot));
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.HostExited && f.Message.Contains("Remote Desktop service (TermService) is not running"));
    }

    [Fact]
    public async Task While_the_Remote_Desktop_service_stays_stopped_the_connection_fails_with_that_reason()
    {
        var manager = Manager(readySeconds: 10);
        _remoteDesktop.StoppedChecks = int.MaxValue;

        var e = await Drive(Fails(() => manager.EnsureAsync(CancellationToken.None)));

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.Contains("TermService", e.Message);
        Assert.Equal(0, _host.Calls);
    }

    [Fact]
    public async Task A_connection_that_has_closed_when_it_is_returned_is_a_failed_attempt_and_its_session_is_signed_out()
    {
        // Its host ended as the session became Active: the session is not handed out, it is signed out, and another
        // attempt follows.
        var manager = Manager();
        _host.ClosedOnReturn = 1;

        await Drive(manager.EnsureAsync(CancellationToken.None).ContinueWith(t => t.Exception));

        Assert.Equal(["connect", "signout 10", "connect"], _events);
        Assert.Equal(11u, Assert.Single(_sessions.ForUser(Bot)).Id);
        Assert.Equal(11u, ReadState()["sessionId"]!.GetValue<uint>());
        Assert.Contains(_log.Failures, f => f.Reason == SessionFailure.HostExited && f.Message.Contains("ended as soon as the session was ready"));
    }

    [Fact]
    public async Task A_caller_that_gives_up_after_failed_attempts_gets_the_reason_they_failed_for()
    {
        var manager = Manager(readySeconds: 45);
        _host.AlwaysFail = SessionFailure.HostExited;
        using var caller = new CancellationTokenSource(TimeSpan.FromSeconds(5), _time);

        var e = await Drive(Fails(() => manager.EnsureAsync(caller.Token)));

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.StartsWith("HostExited", manager.LastFailure);
    }

    [Fact]
    public async Task StopAsync_signs_our_session_out()
    {
        var manager = Manager();
        using var hold = manager.Hold();
        await manager.EnsureAsync(CancellationToken.None);
        var id = _sessions.ForUser(Bot)[0].Id;

        await manager.StopAsync();

        Assert.Equal([id], _sessions.SignOuts);
        Assert.Null(ReadState()["sessionId"]);
        await Fails(() => manager.EnsureAsync(CancellationToken.None));
        Assert.Equal(1, _host.Calls);
    }
}
