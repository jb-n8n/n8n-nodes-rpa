using System.Globalization;

namespace Rpa.Supervisor.Core;

/// <summary>
/// The supervisor's log file, in a folder the installer creates and only SYSTEM and administrators can write (this
/// class does not create it). The same failure line again within 30 s is counted instead of written; when it is
/// written again, the count follows it. Info lines are always written: they are events (a sign-in, a sign-out). A log
/// larger than maxBytes moves to &lt;name&gt;.1.log (replacing the one there) and a new one starts. A line that cannot
/// be written is dropped: the log never stops the supervisor.
/// </summary>
public sealed class FileSupervisorLog : ISupervisorLog
{
    private static readonly TimeSpan RepeatInterval = TimeSpan.FromSeconds(30);
    private const int MaxRemembered = 256;

    private readonly string _path;
    private readonly string _previousPath;
    private readonly TimeProvider _time;
    private readonly long _maxBytes;
    private readonly object _gate = new();
    private readonly Dictionary<string, (DateTimeOffset WrittenAt, int Left)> _recent = new(StringComparer.Ordinal);

    public FileSupervisorLog(string path, TimeProvider time, long maxBytes = 5 * 1024 * 1024)
    {
        _path = path;
        _previousPath = Path.ChangeExtension(path, ".1" + Path.GetExtension(path));
        _time = time;
        _maxBytes = maxBytes;
    }

    public void Info(string message)
    {
        lock (_gate) Append(_time.GetUtcNow(), $"INFO {message}");
    }

    public void Failure(SessionFailure? reason, string message)
    {
        var text = reason is { } r ? $"FAIL {r}: {message}" : $"FAIL {message}";
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            var suffix = "";
            if (_recent.TryGetValue(text, out var seen))
            {
                if (now - seen.WrittenAt < RepeatInterval)
                {
                    _recent[text] = seen with { Left = seen.Left + 1 };
                    return;
                }
                if (seen.Left > 0) suffix = $" ({seen.Left} more {(seen.Left == 1 ? "time" : "times")} since it was last written)";
            }
            Forget(now);
            _recent[text] = (now, 0);
            Append(now, text + suffix);
        }
    }

    // Under _gate.
    private void Append(DateTimeOffset now, string text)
    {
        var line = $"{now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)} {text}{Environment.NewLine}";
        try
        {
            var file = new FileInfo(_path);
            if (file.Exists && file.Length + line.Length > _maxBytes) File.Move(_path, _previousPath, overwrite: true);
            File.AppendAllText(_path, line);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    // Keeps the memory of written lines small: lines older than the interval are no longer needed.
    private void Forget(DateTimeOffset now)
    {
        if (_recent.Count < MaxRemembered) return;
        foreach (var (key, value) in _recent.ToArray())
            if (now - value.WrittenAt >= RepeatInterval) _recent.Remove(key);
    }
}
