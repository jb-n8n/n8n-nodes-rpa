namespace Rpa.Recorder.Core;

/// <summary>A process as Windows describes it: its id, its parent's id, its program file (null when it cannot be read)
/// and when it started (null when unknown).</summary>
public sealed record ProcessFacts(int Id, int ParentId, string? ImagePath, DateTimeOffset? Started);

/// <summary>
/// Which input belongs to the recording. A recording is of one application, and a run drives only what it launched,
/// so input is recorded only when its top-level window belongs to the recorded application: the process the recorder
/// started or attached to, a process it started (or one those started), or another process of the same program file.
/// Everything else is out of scope: it is not described, no field there is read, and nothing of it is kept. A process
/// that cannot be looked at, or whose program file cannot be read, is out of scope. A parent id counts only for a
/// process that started after that parent (Windows reuses the ids of processes that ended). Once the recorded process
/// has exited (<see cref="AppExited"/>), its id is no longer in scope, and a process counts as its child only when it
/// started before the exit.
/// </summary>
public sealed class AppScope(ProcessFacts app, string? programPath)
{
    /// <summary>How many generations of children are followed.</summary>
    private const int Generations = 8;

    private readonly object _gate = new();
    private DateTimeOffset? _exited;

    public int ProcessId => app.Id;

    /// <summary>The recorded process has exited: its id may now be another program's.</summary>
    public void AppExited(DateTimeOffset at)
    {
        lock (_gate) _exited ??= at;
    }

    /// <param name="lookup">Describes a process by its id; null when it cannot be looked at.</param>
    public bool Includes(int processId, Func<int, ProcessFacts?> lookup)
    {
        DateTimeOffset? exited;
        lock (_gate) exited = _exited;
        if (processId == app.Id && exited is null) return true;
        var process = lookup(processId);
        if (process?.ImagePath is null) return false;
        if (programPath is not null && string.Equals(process.ImagePath, programPath, StringComparison.OrdinalIgnoreCase)) return true;
        for (var i = 0; i < Generations && process?.Started is { } started; i++)
        {
            if (process.ParentId == app.Id) return app.Started is { } appStarted && started >= appStarted && (exited is null || started <= exited);
            var parent = lookup(process.ParentId);
            if (parent?.Started is not { } parentStarted || parentStarted > started) return false;
            process = parent;
        }
        return false;
    }
}
