namespace Rpa.Runner.Core;

/// <summary>
/// A small line logger to stdout and, when a directory is given, a daily file. Callers log methods, outcomes and error
/// codes only: never tokens, typed values, segment text, element values or file contents.
/// </summary>
public sealed class RunnerLog
{
    private readonly object _gate = new();
    private readonly string? _dir;
    private readonly bool _console;

    public RunnerLog(string? directory, bool console = true)
    {
        _dir = directory;
        _console = console;
        if (_dir is not null) Directory.CreateDirectory(_dir);
    }

    public static RunnerLog Silent { get; } = new(null, console: false);

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        var now = DateTimeOffset.UtcNow;
        var line = $"{now:yyyy-MM-ddTHH:mm:ss.fffZ} {level} {message}";
        lock (_gate)
        {
            if (_console) Console.WriteLine(line);
            if (_dir is null) return;
            try { File.AppendAllText(Path.Combine(_dir, $"runner-{now:yyyyMMdd}.log"), line + Environment.NewLine); }
            catch (IOException) { /* logging must never fail a request */ }
        }
    }
}
