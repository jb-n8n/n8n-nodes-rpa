using System.Globalization;

namespace Rpa.Supervisor.Core;

/// <summary>
/// The supervisor's log file. The same line again within 30 s is counted instead of written; when it is written again,
/// the count follows it. A log larger than maxBytes moves to &lt;name&gt;.1.log (replacing the one there) and a new one
/// starts. A line that cannot be written is dropped: the log never stops the supervisor. So is a line whose file or
/// folder is a link (a reparse point): the service runs as SYSTEM, and others may be able to change what is in its log
/// folder. This is checked just before each write, so a link put there in between is not seen.
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

    public void Info(string message) => Write($"INFO {message}");

    public void Failure(SessionFailure? reason, string message) =>
        Write(reason is { } r ? $"FAIL {r}: {message}" : $"FAIL {message}");

    private void Write(string text)
    {
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
                if (seen.Left > 0) suffix = $" ({seen.Left} more times since it was last written)";
            }
            Forget(now);
            _recent[text] = (now, 0);

            var line = $"{now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)} {text}{suffix}{Environment.NewLine}";
            try
            {
                var folder = Path.GetDirectoryName(_path)!;
                Directory.CreateDirectory(folder);
                if (IsLink(folder) || IsLink(_path) || IsLink(_previousPath)) return;
                var file = new FileInfo(_path);
                if (file.Exists && file.Length + line.Length > _maxBytes) File.Move(_path, _previousPath, overwrite: true);
                File.AppendAllText(_path, line);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    // Looks at the entry itself, not at what a link points to (which may not exist).
    private static bool IsLink(string path)
    {
        try
        {
            return File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return false;
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
