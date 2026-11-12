using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core.Runs;

/// <summary>The active run: its id, export directory, lease and the processes it launched.</summary>
public sealed class RunState
{
    private readonly object _gate = new();
    private readonly HashSet<int> _pids = [];

    internal RunState(string runId, string exportDir, TimeSpan lease, DateTimeOffset deadline)
    {
        RunId = runId;
        ExportDir = exportDir;
        Lease = lease;
        Deadline = deadline;
    }

    public string RunId { get; }
    public string ExportDir { get; }
    public TimeSpan Lease { get; }
    internal DateTimeOffset Deadline { get; set; }
    internal int InFlight { get; set; }
    private bool _ended;

    internal bool Ended
    {
        get { lock (_gate) return _ended; }
        set { lock (_gate) _ended = value; }
    }

    /// <summary>Records a launched process; false when the run already ended (the caller must stop the process).
    /// Shares a lock with <see cref="Ended"/>, so cleanup never misses a process added while the run ends.</summary>
    public bool TryAddProcess(int pid)
    {
        lock (_gate)
        {
            if (_ended) return false;
            _pids.Add(pid);
            return true;
        }
    }

    public void AddProcess(int pid)
    {
        if (!TryAddProcess(pid)) throw RpcErrors.NoRun();
    }

    public IReadOnlyCollection<int> Processes
    {
        get { lock (_gate) return _pids.ToArray(); }
    }

    /// <summary>The run's most recent act: the clipboard's sequence number right before it, and when it finished (or
    /// started, while it is still running). Null before the run's first act. clipboard.read compares against it.</summary>
    internal ActMark? LastAct { get; set; }
}

/// <summary>The clipboard's sequence number before an act of the run, and the time of that act.</summary>
internal sealed record ActMark(uint ClipboardSequence, DateTimeOffset At);

/// <summary>
/// One run at a time (the run lock), held under a lease. run.heartbeat renews the lease, and so does the end of every
/// other request for the run; the lease never expires while a request for the run is still being handled. When the
/// lease expires the run ends exactly as on run.end: the processes it launched are killed, its export directory is
/// deleted and the lock is released.
/// </summary>
public sealed class RunManager : IDisposable
{
    public const long MinLeaseMs = 5000;
    public const long MaxLeaseMs = 600000;

    /// <summary>How long the launched apps get, in total, to close by themselves after the close request.</summary>
    public static readonly TimeSpan CloseWait = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ClosePoll = TimeSpan.FromMilliseconds(100);

    private readonly object _gate = new();
    private readonly string _exportRoot;
    private readonly IProcessHost _processes;
    private readonly IPathSecurity _paths;
    private readonly TimeProvider _time;
    private readonly RunnerLog _log;
    private RunState? _active;
    private ITimer? _timer;

    public RunManager(string exportRoot, IProcessHost processes, TimeProvider time, RunnerLog log, IPathSecurity? paths = null)
    {
        _exportRoot = exportRoot;
        _processes = processes;
        _paths = paths ?? new DefaultPathSecurity();
        _paths.CreatePrivateDirectory(exportRoot);
        _time = time;
        _log = log;
    }

    /// <summary>Fires after a run ended (explicitly or by lease), with the run id and the reason.</summary>
    public event Action<string, string>? RunEnded;

    public RunState Begin(string runId, long leaseMs)
    {
        if (string.IsNullOrEmpty(runId) || runId.Length > 200) throw RpcErrors.InvalidParamsError("runId must be 1 to 200 characters");
        if (leaseMs is < MinLeaseMs or > MaxLeaseMs)
            throw RpcErrors.InvalidParamsError($"leaseMs must be between {MinLeaseMs} and {MaxLeaseMs}");
        lock (_gate)
        {
            // Busy while a run is active and while the previous run is still being cleaned up.
            if (_active is not null || _cleaning is not null) throw RpcErrors.RunnerBusy();
            // A fresh, unguessable directory per run; the run id is caller-chosen and never used in the path.
            var dir = Path.Combine(_exportRoot, Guid.NewGuid().ToString("N"));
            _paths.CreatePrivateDirectory(dir);
            var lease = TimeSpan.FromMilliseconds(leaseMs);
            _active = new RunState(runId, Path.GetFullPath(dir), lease, _time.GetUtcNow() + lease);
            _timer?.Dispose();
            _timer = _time.CreateTimer(_ => OnTimer(), null, lease, Timeout.InfiniteTimeSpan);
            _log.Info($"run.begin lease={leaseMs}ms");
            return _active;
        }
    }

    /// <summary>The active run if the id matches; otherwise no_run.</summary>
    public RunState Get(string? runId)
    {
        lock (_gate)
        {
            if (_active is null || runId is null || !string.Equals(_active.RunId, runId, StringComparison.Ordinal))
                throw RpcErrors.NoRun();
            return _active;
        }
    }

    /// <summary>Marks a request for the run as in flight; disposing renews the lease.</summary>
    public IDisposable Enter(string? runId)
    {
        lock (_gate)
        {
            var run = Get(runId);
            run.InFlight++;
            return new Scope(this, run);
        }
    }

    public void Heartbeat(string? runId)
    {
        lock (_gate)
        {
            var run = Get(runId);
            Renew(run);
        }
    }

    /// <summary>Ends the run. The answer does not wait for the apps to close: cleanup (close request, up to
    /// <see cref="CloseWait"/>, stop, delete the export folder) goes on after it, and run.begin stays busy until it
    /// has finished. Before the close wait existed the answer came after the cleanup; with it the answer could take
    /// longer than the engine's 5 seconds for run.end.</summary>
    public void End(string? runId)
    {
        RunState run;
        lock (_gate)
        {
            run = Get(runId);
            Detach(run);
        }
        _ = CleanupAsync(run, "run.end", polite: true);
    }

    /// <summary>Completes when no cleanup is running (the one after run.end or a lease that ran out).</summary>
    public Task WaitForCleanupAsync()
    {
        lock (_gate) return _cleanup ?? Task.CompletedTask;
    }

    public bool HasActiveRun
    {
        get { lock (_gate) return _active is not null; }
    }

    private void Renew(RunState run)
    {
        run.Deadline = _time.GetUtcNow() + run.Lease;
        _timer?.Change(run.Lease, Timeout.InfiniteTimeSpan);
    }

    private void OnTimer()
    {
        RunState? expired = null;
        lock (_gate)
        {
            var run = _active;
            if (run is null) return;
            var now = _time.GetUtcNow();
            if (run.InFlight > 0)
            {
                // Never pull the run out from under a request; re-check shortly after it should have finished.
                _timer?.Change(TimeSpan.FromSeconds(1), Timeout.InfiniteTimeSpan);
                return;
            }
            if (now < run.Deadline)
            {
                _timer?.Change(run.Deadline - now, Timeout.InfiniteTimeSpan);
                return;
            }
            Detach(run);
            expired = run;
        }
        _ = CleanupAsync(expired, "lease expired", polite: true);
    }

    // Under _gate: the run is no longer active, so new requests for it get no_run; run.begin stays busy until Cleanup
    // has finished.
    private void Detach(RunState run)
    {
        run.Ended = true;
        _timer?.Dispose();
        _timer = null;
        _cleaning = run;
        _active = null;
    }

    private RunState? _cleaning;
    private Task? _cleanup;

    // Starts on the caller's thread and returns at its first wait, so the caller is not held up by the close wait.
    private async Task CleanupAsync(RunState run, string reason, bool polite)
    {
        Task done;
        var finished = new TaskCompletionSource();
        lock (_gate) { done = finished.Task; _cleanup = done; }
        try
        {
            var pids = run.Processes;
            var asked = new HashSet<int>();
            if (polite)
            {
                // Ask first. Nothing is typed, clicked or answered: an app that asks "Save changes?" gets no answer
                // and is stopped when the wait is over.
                foreach (var pid in pids)
                {
                    if (SafeHasExited(pid)) continue;
                    asked.Add(pid);
                    try { _processes.RequestClose(pid); }
                    catch (Exception e) { _log.Warn($"could not ask a process the run launched to close ({e.GetType().Name})"); }
                }
                var until = _time.GetUtcNow() + CloseWait;
                while (asked.Any(pid => !SafeHasExited(pid)) && _time.GetUtcNow() < until)
                    await Task.Delay(ClosePoll, _time).ConfigureAwait(false);
            }
            foreach (var pid in pids)
            {
                var ended = SafeHasExited(pid);
                _log.Info(!ended && !polite ? $"app pid={pid} was stopped"
                    : !ended ? $"app pid={pid} did not close in {CloseWait.TotalSeconds:0} seconds and was stopped"
                    : asked.Contains(pid) ? $"app pid={pid} closed by itself after the close request"
                    : $"app pid={pid} had already ended");
                // Called for every process, also an ended one: it releases the job (and so stops helpers the app left).
                try { _processes.KillTree(pid); }
                catch (Exception e) { _log.Warn($"could not stop a process the run launched ({e.GetType().Name})"); }
            }
            DeleteDirectory(run.ExportDir);
        }
        finally
        {
            lock (_gate) { if (ReferenceEquals(_cleaning, run)) _cleaning = null; }
            _log.Info($"run ended ({reason})");
            try { RunEnded?.Invoke(run.RunId, reason); }
            finally { finished.SetResult(); }
        }
    }

    private bool SafeHasExited(int pid)
    {
        try { return _processes.HasExited(pid); }
        catch (Exception) { return false; }
    }

    private void DeleteDirectory(string dir)
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A just-killed process may still hold a file for a moment.
                Thread.Sleep(200);
            }
        }
        _log.Warn("could not delete a run's export directory; it is removed at the next start");
    }

    /// <summary>Removes export directories a crashed runner left behind. Called at start.</summary>
    public void SweepStaleExportDirs()
    {
        if (!Directory.Exists(_exportRoot)) return;
        foreach (var d in Directory.GetDirectories(_exportRoot)) DeleteDirectory(d);
    }

    public void Dispose()
    {
        RunState? run;
        lock (_gate)
        {
            run = _active;
            if (run is not null) Detach(run);
        }
        // The runner is stopping: no close wait (the apps also die with the runner's jobs).
        if (run is not null) CleanupAsync(run, "runner stopping", polite: false).GetAwaiter().GetResult();
    }

    private sealed class Scope(RunManager owner, RunState run) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
            lock (owner._gate)
            {
                run.InFlight--;
                if (!run.Ended && ReferenceEquals(owner._active, run)) owner.Renew(run);
            }
        }
    }
}
