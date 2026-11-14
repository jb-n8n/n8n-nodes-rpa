using Microsoft.Extensions.Time.Testing;

namespace Rpa.Supervisor.Core.Tests;

public sealed class FileSupervisorLogTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("rpa-supervisor-log-").FullName;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));

    // The installer makes the folder; the log does not.
    public FileSupervisorLogTests() => Directory.CreateDirectory(Path.Combine(_dir, "supervisor"));

    public void Dispose() => Directory.Delete(_dir, true);

    private string LogFile => Path.Combine(_dir, "supervisor", "supervisor.log");

    private string[] Lines() => File.ReadAllLines(LogFile);

    [Fact]
    public void Each_line_has_the_time_the_level_and_the_message()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Info("Signed rpabot in: session 3.");
        _time.Advance(TimeSpan.FromSeconds(1));
        log.Failure(SessionFailure.WrongPassword, "Windows refused the password of rpabot.");
        log.Failure(null, "Accepting a connection on port 8765 failed.");

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z INFO Signed rpabot in: session 3.",
            "2026-11-10T08:00:01.000Z FAIL WrongPassword: Windows refused the password of rpabot.",
            "2026-11-10T08:00:01.000Z FAIL Accepting a connection on port 8765 failed.",
        ], Lines());
    }

    [Fact]
    public void Without_its_folder_the_log_writes_nothing_and_does_not_make_the_folder()
    {
        var missing = Path.Combine(_dir, "missing", "supervisor.log");

        new FileSupervisorLog(missing, _time).Info("Signed rpabot in: session 3.");

        Assert.False(Directory.Exists(Path.GetDirectoryName(missing)));
    }

    [Fact]
    public void The_same_failure_again_within_30_s_is_counted_not_written()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Failure(SessionFailure.HostExited, "Sign-in attempt for rpabot failed.");
        for (var i = 0; i < 5; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(2));
            log.Failure(SessionFailure.HostExited, "Sign-in attempt for rpabot failed.");
            log.Failure(null, "Another failure.");
        }

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z FAIL HostExited: Sign-in attempt for rpabot failed.",
            "2026-11-10T08:00:02.000Z FAIL Another failure.",
        ], Lines());
    }

    [Fact]
    public void Info_lines_are_events_and_always_written()
    {
        // With idleSeconds 0 each connection signs in and out; every one of those lines counts.
        var log = new FileSupervisorLog(LogFile, _time);
        for (var i = 0; i < 3; i++) log.Info("No connection for 0 s; signing rpabot out.");

        Assert.Equal(3, Lines().Length);
    }

    [Fact]
    public void After_30_s_the_failure_is_written_again_with_how_often_it_was_left_out()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Failure(null, "Accepting a connection on port 8765 failed.");
        for (var i = 0; i < 3; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(10));
            log.Failure(null, "Accepting a connection on port 8765 failed.");
        }
        _time.Advance(TimeSpan.FromSeconds(20));
        log.Failure(null, "Accepting a connection on port 8765 failed.");
        _time.Advance(TimeSpan.FromSeconds(30));
        log.Failure(null, "Accepting a connection on port 8765 failed.");

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z FAIL Accepting a connection on port 8765 failed.",
            "2026-11-10T08:00:30.000Z FAIL Accepting a connection on port 8765 failed. (2 more times since it was last written)",
            "2026-11-10T08:01:20.000Z FAIL Accepting a connection on port 8765 failed. (1 more time since it was last written)",
        ], Lines());
    }

    [Fact]
    public void A_full_log_moves_to_supervisor_1_log_and_a_new_one_starts()
    {
        var log = new FileSupervisorLog(LogFile, _time, maxBytes: 200);
        for (var i = 0; i < 6; i++) log.Info($"Line {i} of the supervisor's log, long enough to fill it.");

        var previous = File.ReadAllLines(Path.Combine(_dir, "supervisor", "supervisor.1.log"));
        Assert.All(previous.Concat(Lines()), line => Assert.Contains("of the supervisor's log", line));
        Assert.True(new FileInfo(LogFile).Length <= 200);
        Assert.EndsWith("Line 5 of the supervisor's log, long enough to fill it.", Lines()[^1]);
    }
}
