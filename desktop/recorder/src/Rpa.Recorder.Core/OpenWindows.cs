namespace Rpa.Recorder.Core;

/// <summary>
/// Which windows "Record an open window..." offers: windows a person can mean. Left out are windows without a title,
/// cloaked windows (Windows keeps them out of sight, such as its text input host), the shell's desktop and taskbar
/// windows, and the recorder's own.
/// </summary>
public static class OpenWindows
{
    private static readonly string[] ShellClasses = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    public static bool IsOffered(string title, string className, bool cloaked, bool own) =>
        !own && !cloaked && !string.IsNullOrWhiteSpace(title) && !ShellClasses.Contains(className, StringComparer.Ordinal);
}
