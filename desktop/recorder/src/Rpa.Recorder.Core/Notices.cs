namespace Rpa.Recorder.Core;

/// <summary>The kinds of notice the Windows layer gives (headless mode prints the kind, never the text).</summary>
public enum NoticeKind { Late, HookLost, Elevated, NotStarted, OtherProgram, NotRead, TooManySteps, CtrlAltDropped }

/// <summary>
/// What the recorder tells the person, on its bar's notice line (and, in headless mode, as its kind on standard error).
/// Each says what happened and what to do; the bar shows it on one line, cut when longer, and whole in its tooltip.
/// </summary>
public static class Notices
{
    /// <summary>The note under the arguments box of Start an app.</summary>
    public const string Arguments = "Do not put a password here: arguments are saved in the recording.";

    public const string CtrlAltDropped =
        "A Ctrl+Alt shortcut was not recorded: on many keyboards Ctrl+Alt types characters. Use the app's menu for that step.";

    /// <summary>
    /// Whether a key was pressed and dropped because it is Ctrl+Alt with a key that types (AltGr is Ctrl+Alt on many
    /// keyboards, and may be part of a password): such a key is typing in a field, and dropped anywhere else.
    /// </summary>
    public static bool ShortcutDropped(bool ctrl, bool alt, KeyKind kind, FieldKind field) =>
        ctrl && alt && kind == KeyKind.Printable && field == FieldKind.None;

    public const string ProgramUnknown =
        "Windows did not say which program this window belongs to, so it cannot be recorded. Start the app with Start an app… instead.";

    public const string PasswordNotRead = "F9 added nothing: a password box is never read.";

    public static string NotRead(string field) =>
        $"The value typed into \"{Short(field)}\" could not be read, so that step is not in the recording: add it by hand.";

    public static string TooManySteps(int steps) =>
        $"The recording makes about {steps} steps, and Import Steps takes at most {RecordingFile.MaxSteps}: delete steps, or record the work in shorter parts.";

    public const string OtherPrograms = "Input in other programs is not recorded.";

    public const string Elevated =
        "This app runs as administrator, so the recorder cannot see inside it. Start the recorder as administrator to record it.";

    public const string HookLost =
        "The recorder missed some input (the app was slow, or an administrator's window had it). Check the last steps.";

    public static string Late(string step) =>
        $"Check the step on \"{Short(step)}\": the app answered late, so it was recorded as it was then. Delete it if it is wrong.";

    public const string NotStarted = "The app showed no window within 30 seconds. Try again, or open it yourself and use it from the bar.";

    public static string DidNotStart(string reason) => $"The app did not start: {reason}";

    /// <summary>A label as a notice quotes it: one line, at most 40 characters.</summary>
    internal static string Short(string label)
    {
        var line = string.Join(' ', label.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries));
        return line.Length > 40 ? line[..39] + "…" : line;
    }
}
