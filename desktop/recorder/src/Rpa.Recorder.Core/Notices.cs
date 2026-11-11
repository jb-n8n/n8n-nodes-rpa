namespace Rpa.Recorder.Core;

/// <summary>What the recorder tells the person, on its bar (and, in headless mode, on standard error).</summary>
public static class Notices
{
    public const string Arguments = "Do not put a password into the program's arguments: arguments are saved in the recording.";

    public const string CtrlAltShortcuts =
        "A shortcut with Ctrl+Alt and a letter or digit is not recorded: AltGr is Ctrl+Alt on many keyboards and types characters, which may be part of a password.";

    public const string ProgramUnknown = "The program of this window could not be read, so it cannot be recorded.";

    public const string PasswordNotRead = "A password field cannot be read into the run's output.";

    public static string NotRead(string field) =>
        $"The value typed into \"{field}\" could not be read, so that step is not in the recording: add it by hand.";

    public static string TooManySteps(int steps) =>
        $"The recording makes about {steps} steps, and Import Steps takes at most {RecordingFile.MaxSteps}: delete steps, or record the work in shorter parts.";

    public const string OtherPrograms = "Input in other programs is not recorded.";

    public const string Elevated =
        "This window belongs to a program that runs as administrator. The recorder cannot see inside it: start the recorder as administrator to record it.";

    public const string HookLost =
        "The recorder missed input: Windows stopped passing it on (the application was slow to answer), or it went to a program that runs as administrator. The recorder is listening again; check the last steps and record again what is missing.";

    public static string Late(string step) =>
        $"The application took longer than 200 ms to describe \"{step}\", so the step was recorded as it was then. Check it, and delete it if it is wrong.";

    public const string NotStarted = "The program did not show a window within 30 seconds.";

    public static string DidNotStart(string reason) => $"The program did not start: {reason}";
}
