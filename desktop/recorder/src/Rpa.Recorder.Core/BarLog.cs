using System.Globalization;
using System.Text;

namespace Rpa.Recorder.Core;

/// <summary>The bar's buttons as the bar log names them. PauseOrResume is one button: the stage says which it was.</summary>
public enum BarButton { StartApp, UseOpenApp, PauseOrResume, Finish, Back, Continue, DeleteStep, MakeSecret, ChangeFolder, Save, Allow, ShowFile, RecordAnother }

/// <summary>
/// A log of the bar's own actions, so that a bar that seemed to do nothing leaves a trace: one line per stage change
/// and per button pressed, with the time. It takes only a stage and a button, both enums, so no step text, typed value,
/// window title or file path can reach it. A file of <see cref="MaxBytes"/> or more is started again. A failure to
/// write is ignored.
/// </summary>
/// <param name="path">The log file (<see cref="PathIn"/>), or null for no log.</param>
public sealed class BarLog(string? path, Func<DateTimeOffset> now)
{
    public const long MaxBytes = 200 * 1024;
    private BarStage? _stage;

    /// <summary><c>RPA Recorder\bar.log</c> in the user's local application data, or null when there is none.</summary>
    public static string? PathIn(string localAppData) => localAppData.Length == 0 ? null : Path.Combine(localAppData, "RPA Recorder", "bar.log");

    /// <summary>A line when the stage is not the one last written.</summary>
    public void Stage(BarStage stage)
    {
        if (_stage == stage) return;
        _stage = stage;
        Write($"stage {stage}");
    }

    public void Pressed(BarButton button, BarStage stage) => Write($"button {button} in {stage}");

    private void Write(string what)
    {
        if (path is null) return;
        var line = $"{now().ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture)} {what}{Environment.NewLine}";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var file = new FileInfo(path);
            var mode = file.Exists && file.Length + Encoding.UTF8.GetByteCount(line) >= MaxBytes ? FileMode.Create : FileMode.Append;
            using var stream = new FileStream(path, mode, FileAccess.Write, FileShare.ReadWrite);
            stream.Write(Encoding.UTF8.GetBytes(line));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { }
    }
}
