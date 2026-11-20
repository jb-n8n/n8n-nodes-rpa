namespace Rpa.Recorder.Core;

/// <summary>
/// Which input belongs to the recording. A recording is of one application, and a run drives only what it launched,
/// so input is recorded only when its top-level window belongs to the recorded process or to another process of the
/// same program file. Everything else is another program, also a process the application started: it is not
/// described, no field there is read, and nothing of it is kept. A process whose program file cannot be read is out of
/// scope. Once the recorded process has exited (<see cref="AppExited"/>), its id alone no longer counts: Windows may
/// have given it to another program.
/// </summary>
public sealed class AppScope(int processId, string? programPath)
{
    private volatile bool _exited;

    /// <summary>The recorded process has exited: its id may now be another program's.</summary>
    public void AppExited() => _exited = true;

    /// <param name="imagePath">A process's program file by its id; null when it cannot be read.</param>
    public bool Includes(int id, Func<int, string?> imagePath)
    {
        if (id == processId && !_exited) return true;
        return programPath is not null && imagePath(id) is { } path && string.Equals(path, programPath, StringComparison.OrdinalIgnoreCase);
    }
}
