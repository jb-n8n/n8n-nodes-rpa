using Microsoft.Extensions.Time.Testing;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;

namespace Rpa.Runner.Core.Tests;

public sealed class RunManagerTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("rpa-runs-").FullName;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-29T10:00:00Z"));
    private readonly FakeProcessHost _procs = new();
    private readonly RunManager _runs;

    public RunManagerTests() => _runs = new RunManager(_root, _procs, _time, RunnerLog.Silent);

    public void Dispose()
    {
        _runs.Dispose();
        Directory.Delete(_root, true);
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
    public void End_kills_launched_processes_deletes_the_export_dir_and_releases_the_lock()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(41);
        run.AddProcess(42);
        File.WriteAllText(Path.Combine(run.ExportDir, "x.csv"), "data");
        _runs.End("a");
        Assert.Equal([41, 42], _procs.Killed.Order());
        Assert.False(Directory.Exists(run.ExportDir));
        Assert.False(_runs.HasActiveRun);
        _runs.Begin("b", 5000);
    }

    [Fact]
    public void The_lease_expires_like_run_end()
    {
        var run = _runs.Begin("a", 5000);
        run.AddProcess(7);
        string? ended = null;
        _runs.RunEnded += (id, reason) => ended = $"{id}:{reason}";
        _time.Advance(TimeSpan.FromMilliseconds(4999));
        Assert.True(_runs.HasActiveRun);
        _time.Advance(TimeSpan.FromMilliseconds(2));
        Assert.False(_runs.HasActiveRun);
        Assert.Equal([7], _procs.Killed);
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
