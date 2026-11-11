namespace Rpa.Recorder.Core;

/// <summary>
/// The names of the two files Save writes: <c>&lt;name&gt;.rpa-recording.json</c> and
/// <c>&lt;name&gt;.policy-change.json</c>, where the name is the recording's, made a valid Windows file name (characters
/// Windows refuses become <c>_</c>, at most 100 characters, a device name such as CON gets a <c>_</c> first).
/// </summary>
public static class SaveNames
{
    public static string Recording(string name) => FileBase(name) + ".rpa-recording.json";

    public static string PolicyChange(string name) => FileBase(name) + ".policy-change.json";

    private static readonly string[] DeviceNames =
        ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
         "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

    private static string FileBase(string name)
    {
        var safe = new string(name.Select(c => c is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*' || char.IsControl(c) ? '_' : c).ToArray());
        if (safe.Length > 100) safe = safe[..100];
        safe = safe.Trim().TrimEnd('.', ' ');
        if (safe.Trim('.').Length == 0) return "recording";
        return DeviceNames.Contains(safe.Split('.')[0], StringComparer.OrdinalIgnoreCase) ? "_" + safe : safe;
    }
}
