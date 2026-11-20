namespace Rpa.Recorder.Core;

/// <summary>
/// The names of the two files Save writes: <c>&lt;name&gt;.rpa-recording.json</c> and
/// <c>&lt;name&gt;.policy-change.json</c>, where the name is the recording's, made a valid Windows file name (characters
/// Windows refuses become <c>_</c>, at most 100 characters, a device name such as CON gets a <c>_</c> first). Save
/// writes them into <c>Documents\RPA recordings</c> unless the person changes the folder.
/// </summary>
public static class SaveNames
{
    public static string Recording(string name) => FileBase(name) + ".rpa-recording.json";

    public static string PolicyChange(string name) => FileBase(name) + ".policy-change.json";

    /// <summary>The folder Save writes into unless the person chooses another: <c>RPA recordings</c> in their Documents
    /// (the bar creates it when it is missing).</summary>
    public static string DefaultFolder(string documents) => Path.Combine(documents, "RPA recordings");

    /// <summary>A folder as the bar shows it: inside Documents as <c>Documents\...</c>, anywhere else in full.</summary>
    public static string FolderShown(string folder, string documents)
    {
        var docs = Path.TrimEndingDirectorySeparator(documents);
        var path = Path.TrimEndingDirectorySeparator(folder);
        if (string.Equals(path, docs, StringComparison.OrdinalIgnoreCase)) return "Documents";
        return path.StartsWith(docs + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? "Documents" + path[docs.Length..] : path;
    }

    /// <summary>The line under the name box: where Save writes.</summary>
    public static string FolderLine(string folderShown) => $"Folder: {folderShown}";

    public const string NameMissing = "Type a name for the recording, then choose Save.";

    public static string NotSaved(string reason) => $"Not saved: {reason}";

    /// <summary>The name the name box starts with: the program's name and "recording" (ErpDemo recording).</summary>
    public static string SuggestedName(string? programPath)
    {
        if (string.IsNullOrEmpty(programPath)) return "Recording";
        var exe = WindowRules.FileName(programPath);
        var stem = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe[..^4] : exe;
        return stem.Length == 0 ? "Recording" : $"{stem} recording";
    }

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
