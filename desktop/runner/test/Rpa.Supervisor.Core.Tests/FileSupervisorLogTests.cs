using Microsoft.Extensions.Time.Testing;

namespace Rpa.Supervisor.Core.Tests;

public sealed class FileSupervisorLogTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("rpa-supervisor-log-").FullName;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-10T08:00:00Z"));

    public void Dispose() => Directory.Delete(_dir, true);

    private string LogFile => Path.Combine(_dir, "logs", "supervisor.log");

    private string[] Lines() => File.ReadAllLines(LogFile);

    [Fact]
    public void Each_line_has_the_time_the_level_and_the_message_and_the_folder_is_made()
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
    public void The_same_line_again_within_30_s_is_counted_not_written()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Info("Sign-in attempt for rpabot failed (HostExited).");
        for (var i = 0; i < 5; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(2));
            log.Info("Sign-in attempt for rpabot failed (HostExited).");
            log.Info("Another line.");
        }

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z INFO Sign-in attempt for rpabot failed (HostExited).",
            "2026-11-10T08:00:02.000Z INFO Another line.",
        ], Lines());
    }

    [Fact]
    public void After_30_s_the_line_is_written_again_with_how_often_it_was_left_out()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Failure(null, "Accepting a connection on port 8765 failed.");
        for (var i = 0; i < 3; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(10));
            log.Failure(null, "Accepting a connection on port 8765 failed.");
        }

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z FAIL Accepting a connection on port 8765 failed.",
            "2026-11-10T08:00:30.000Z FAIL Accepting a connection on port 8765 failed. (2 more times since it was last written)",
        ], Lines());
    }

    [Fact]
    public void A_line_that_comes_back_after_30_s_without_repeats_is_written_plainly()
    {
        var log = new FileSupervisorLog(LogFile, _time);
        log.Info("No connection for 15 s; signing rpabot out.");
        _time.Advance(TimeSpan.FromMinutes(5));
        log.Info("No connection for 15 s; signing rpabot out.");

        Assert.Equal(
        [
            "2026-11-10T08:00:00.000Z INFO No connection for 15 s; signing rpabot out.",
            "2026-11-10T08:05:00.000Z INFO No connection for 15 s; signing rpabot out.",
        ], Lines());
    }

    // The bot user may change what is in logs\; the service runs as SYSTEM and must not write through a link it put there.
    [Fact]
    public void A_log_file_that_is_a_link_is_not_written_through()
    {
        var target = Path.Combine(_dir, "elsewhere.txt");
        File.WriteAllText(target, "untouched");
        Directory.CreateDirectory(Path.GetDirectoryName(LogFile)!);
        File.CreateSymbolicLink(LogFile, target);

        new FileSupervisorLog(LogFile, _time).Info("Signed rpabot in: session 3.");

        Assert.Equal("untouched", File.ReadAllText(target));
    }

    [Fact]
    public void A_log_file_that_is_a_link_to_nothing_does_not_create_its_target()
    {
        var target = Path.Combine(_dir, "created-elsewhere.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(LogFile)!);
        File.CreateSymbolicLink(LogFile, target);

        new FileSupervisorLog(LogFile, _time).Info("Signed rpabot in: session 3.");

        Assert.False(File.Exists(target));
    }

    [Fact]
    public void A_log_folder_that_is_a_link_is_not_written_through()
    {
        var elsewhere = Directory.CreateDirectory(Path.Combine(_dir, "elsewhere")).FullName;
        Directory.CreateSymbolicLink(Path.Combine(_dir, "logs"), elsewhere);

        new FileSupervisorLog(LogFile, _time).Info("Signed rpabot in: session 3.");

        Assert.Empty(Directory.GetFiles(elsewhere));
    }

    [Fact]
    public void A_full_log_moves_to_supervisor_1_log_and_a_new_one_starts()
    {
        var log = new FileSupervisorLog(LogFile, _time, maxBytes: 200);
        for (var i = 0; i < 6; i++) log.Info($"Line {i} of the supervisor's log, long enough to fill it.");

        var previous = File.ReadAllLines(Path.Combine(_dir, "logs", "supervisor.1.log"));
        Assert.All(previous.Concat(Lines()), line => Assert.Contains("of the supervisor's log", line));
        Assert.True(new FileInfo(LogFile).Length <= 200);
        Assert.EndsWith("Line 5 of the supervisor's log, long enough to fill it.", Lines()[^1]);
    }
}
