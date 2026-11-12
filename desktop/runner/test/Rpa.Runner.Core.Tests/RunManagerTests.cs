using Microsoft.Extensions.Time.Testing;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;

namespace Rpa.Runner.Core.Tests;

public sealed class RunManagerTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("rpa-runs-").FullName;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-29T10:00:00Z"));
    private readonly FakeProcessHost _procs = new();
    private readonly string _logDir = Directory.CreateTempSubdirectory("rpa-runs-log-").FullName;
    private readonly RunManager _runs;

    public RunManagerTests() => _runs = new RunManager(_root, _procs, _time, new RunnerLog(_logDir, console: false));

    public void Dispose()
    {
        _runs.Dispose();
        Directory.Delete(_root, true);
        Directory.Delete(_logDir, true);
    }

    private string LogText() => string.Concat(Directory.GetFiles(_logDir).Select(File.ReadAllText));

    /// <summary>Moves the fake clock in 100 ms steps until the cleanup is done (at most 10 fake seconds).</summary>
    private async Task Settle()
    {
        var done = _runs.WaitForCleanupAsync();
        for (var i = 0; i < 100 && !done.IsCompleted; i++)
        {
            _time.Advance(TimeSpan.FromMilliseconds(100));
            await Task.WhenAny(done, Task.Delay(10));
        }
        await done.WaitAsync(TimeSpan.FromSeconds(10));
    }

    /// <summary>Moves the fake clock by <paramref name="total"/> in 100 ms steps, giving the cleanup time to run.</summary>
    private async Task Pass(TimeSpan total)
    {
        for (var t = TimeSpan.Zero; t < total; t += TimeSpan.FromMilliseconds(100))
        {
            _time.Advance(TimeSpan.FromMilliseconds(100));
            await Task.Delay(10);
        }
    }

    [Fact]
    public void Begin_creates_a_fresh_absolute_export_dir_not_named_after_the_run()
    {
        var run = _runs.Begin("../../evil", 5000);
        Assert.True(Path.IsPathFullyQualified(run.ExportDir));
        Assert.True(Directory.Exists(run.ExportDir));
        Assert.Empty(Directory.GetFileSystemEntries(run.ExportDir));
        Assert.Equal(Path.GetFullPath(_root), Path.GetDirectoryName(run.ExportDir));
        Assert.DoesNotContain("evil", run.ExportDir);
    }

    [Fact]
    public void A_second_begin_is_busy()
    {
        _runs.Begin("a", 5000);
        Assert.Equal(RpcErrors.RunnerBusyCode, Assert.Throws<RpcException>(() => _runs.Begin("b", 5000)).Code);
        Assert.Equal(RpcErrors.RunnerBusyCode, Assert.Throws<RpcException>(() => _runs.Begin("a", 5000)).Code);
    }

    [Theory]
    [InlineData(4999)]
    [InlineData(600001)]
    public void Lease_must_be_in_range(long lease) =>
        Assert.Equal(RpcErrors.InvalidParams, Assert.Throws<RpcException>(() => _runs.Begin("a", lease)).Code);

    [Fact]
    public void Wrong_or_missing_run_id_is_no_run()
    {
        _runs.Begin("a", 5000);
        Assert.Equal(RpcErrors.NoRunCode, Assert.Throws<RpcException>(() => _runs.Get("b")).Code);
        Assert.Equal(RpcErrors.NoRunCode, Assert.Throws<RpcException>(() => _runs.Get(null)).Code);
        Assert.Equal(RpcErrors.NoRunCode, Assert.Throws<RpcException>(() => _runs.Heartbeat("b")).Code);
        Assert.Equal(RpcErrors.NoRunCode, Assert.Throws<RpcException>(() => _runs.End("b")).Code);
    }

    [Fact]
    public async Task End_stops_launched_processes_deletes_the_export_dir_and_releases_the_lock()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        run.AddProcess(42);
        File.WriteAllText(Path.Combine(run.ExportDir, "x.csv"), "data");
        _runs.End("a");
        await Settle();
        Assert.Equal([41, 42], _procs.Killed.Order());
        Assert.False(Directory.Exists(run.ExportDir));
        Assert.False(_runs.HasActiveRun);
        _runs.Begin("b", 5000);
    }

    [Fact]
    public async Task End_answers_at_once_and_run_begin_stays_busy_until_the_cleanup_is_done()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        _runs.End("a");
        // The answer came back although the app has not closed: it waits for the cleanup in the background.
        Assert.False(_runs.HasActiveRun);
        Assert.Equal(RpcErrors.RunnerBusyCode, Assert.Throws<RpcException>(() => _runs.Begin("b", 5000)).Code);
        Assert.True(Directory.Exists(run.ExportDir));
        await Settle();
        _runs.Begin("b", 5000);
    }

    [Fact]
    public async Task An_app_that_closes_on_request_is_not_stopped_by_force()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        _procs.ClosesOnRequest.Add(41);
        _runs.End("a");
        await Settle();
        Assert.Equal([41], _procs.CloseRequested);
        Assert.Empty(_procs.Killed);
        Assert.Contains("app pid=41 closed by itself after the close request", LogText());
        Assert.False(Directory.Exists(run.ExportDir));
    }

    [Fact]
    public async Task An_app_that_does_not_close_is_stopped_after_three_seconds()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        _runs.End("a");
        await Pass(TimeSpan.FromMilliseconds(2900));
        Assert.Empty(_procs.Killed);
        Assert.True(Directory.Exists(run.ExportDir));
        await Settle();
        Assert.Equal([41], _procs.Killed);
        Assert.Contains("app pid=41 did not close in 3 seconds and was stopped", LogText());
        Assert.False(Directory.Exists(run.ExportDir));
    }

    [Fact]
    public async Task The_three_seconds_are_in_total_not_per_app()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        run.AddProcess(42);
        _procs.ClosesOnRequest.Add(42);
        _runs.End("a");
        await Pass(TimeSpan.FromMilliseconds(2900));
        Assert.Empty(_procs.Killed);
        await Settle();
        Assert.Equal([41], _procs.Killed);
        Assert.Contains("app pid=42 closed by itself", LogText());
    }

    [Fact]
    public async Task An_app_that_already_ended_gets_no_close_request_and_is_not_stopped()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        _procs.Exited.Add(41);
        _runs.End("a");
        await Settle();
        Assert.Empty(_procs.CloseRequested);
        Assert.Empty(_procs.Killed);
        Assert.Contains("app pid=41 had already ended", LogText());
    }

    [Fact]
    public async Task The_order_is_ask_then_wait_then_stop_then_delete_the_folder()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        var folderThereAtStop = false;
        _procs.OnKill = _ => folderThereAtStop = Directory.Exists(run.ExportDir);
        _runs.End("a");
        Assert.Equal(["close:41"], _procs.Events);
        await Pass(TimeSpan.FromMilliseconds(1000));
        Assert.Equal(["close:41"], _procs.Events);
        await Settle();
        Assert.Equal(["close:41", "kill:41"], _procs.Events);
        Assert.True(folderThereAtStop);
        Assert.False(Directory.Exists(run.ExportDir));
    }

    [Fact]
    public async Task The_lease_expires_like_run_end()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(7);
        string? ended = null;
        _runs.RunEnded += (id, reason) => ended = $"{id}:{reason}";
        _time.Advance(TimeSpan.FromMilliseconds(4999));
        Assert.True(_runs.HasActiveRun);
        _time.Advance(TimeSpan.FromMilliseconds(2));
        Assert.False(_runs.HasActiveRun);
        Assert.Equal([7], _procs.CloseRequested);
        Assert.Empty(_procs.Killed);
        await Settle();
        Assert.Equal([7], _procs.Killed);
        Assert.Equal(["close:7", "kill:7"], _procs.Events);
        Assert.False(Directory.Exists(run.ExportDir));
        Assert.Equal("a:lease expired", ended);
        Assert.Equal(RpcErrors.NoRunCode, Assert.Throws<RpcException>(() => _runs.Heartbeat("a")).Code);
    }

    [Fact]
    public void Heartbeat_renews_the_lease()
    {
        _runs.Begin("a", 5000);
        for (var i = 0; i < 5; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(4));
            _runs.Heartbeat("a");
        }
        Assert.True(_runs.HasActiveRun);
        _time.Advance(TimeSpan.FromSeconds(6));
        Assert.False(_runs.HasActiveRun);
    }

    [Fact]
    public void The_lease_does_not_expire_while_a_request_is_in_flight_and_renews_after_it()
    {
        _runs.Begin("a", 5000);
        var scope = _runs.Enter("a");
        _time.Advance(TimeSpan.FromSeconds(30));
        Assert.True(_runs.HasActiveRun);
        scope.Dispose();
        _time.Advance(TimeSpan.FromSeconds(4));
        Assert.True(_runs.HasActiveRun);
        _time.Advance(TimeSpan.FromSeconds(2));
        Assert.False(_runs.HasActiveRun);
    }

    [Fact]
    public void Stale_export_dirs_are_swept_at_start()
    {
        var stale = Directory.CreateDirectory(Path.Combine(_root, "stale")).FullName;
        File.WriteAllText(Path.Combine(stale, "old.csv"), "x");
        _runs.SweepStaleExportDirs();
        Assert.False(Directory.Exists(stale));
    }
}
