namespace Rpa.Recorder.Core;

/// <summary>
/// The common Save dialog of Windows, as the recorder sees it. Its file-name box is an Edit with control id 1001 inside
/// the dialog's <c>FileNameControlHost</c> combo box, in a <c>#32770</c> window; its default button (Save) is control 1.
/// An Open dialog has its own name box (a combo box with control id 1148, without a <c>FileNameControlHost</c>), so it
/// never has a file-name box here: accepting it records no export step. Any other dialog's control 1001 is an ordinary
/// field.
/// </summary>
public static class FileDialogs
{
    /// <summary>The control id of the Save dialog's file-name box.</summary>
    public const int NameBoxId = 1001;

    public static bool IsFileNameBox(WindowFacts window, ElementFacts field) =>
        window.ClassName == "#32770" && field.AutomationId == "1001" && field.Ancestors.Any(a => a.AutomationId == "FileNameControlHost");

    /// <summary>
    /// The dialog that <paramref name="o"/> accepts, or null: a click or Space on a <c>#32770</c> window's default button
    /// (control 1), or Enter in its file-name box or on that button. Enter anywhere else in the dialog (the folder list,
    /// the address bar, Cancel) does something else, and so does a click anywhere else. Whether the dialog is a Save
    /// dialog is told by its file-name box (<see cref="IsFileNameBox"/>), which the Windows layer looks for only then.
    /// </summary>
    public static WindowFacts? AcceptedDialog(Observation o) => o switch
    {
        MouseDown m when IsDefaultButton(m.Window, m.Element) => m.Window,
        Activated a when IsDefaultButton(a.Window, a.Element) => a.Window,
        KeyDown { Typing: false, Chord: "Enter" } k when IsDefaultButton(k.Window, k.Focused) || IsFileNameBox(k.Window, k.Focused) => k.Window,
        _ => null,
    };

    private static bool IsDefaultButton(WindowFacts window, ElementFacts element) =>
        window.ClassName == "#32770" && element.ControlType == "Button" && element.AutomationId == "1";

    /// <summary>A file name without a folder, as the importer takes it (FILE_NAME in recording.ts).</summary>
    public static bool IsFileName(string name) =>
        name.Length is > 0 and <= 255 && name is not "." and not ".." && !name.Any(c => c is '\\' or '/' or ':' or '*' or '?' or '"' or '<' or '>' or '|' || char.IsControl(c));
}
