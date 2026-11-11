using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core;

/// <summary>
/// How a step finds its window again: always by the program's file name, then
/// <list type="bullet">
/// <item>by its window class when the class is the application's own (Notepad's <c>Notepad</c>), so a title that
/// changes while the person works (a document name, an unsaved-changes mark) does not matter;</item>
/// <item>by its title when the class is generated (WinForms <c>WindowsForms10.*</c>, WPF <c>HwndWrapper[...]</c>, a
/// class the stable-id rule takes for generated), since the title is all there is;</item>
/// <item>by its title and class when the class is one Windows shares between applications (<c>#32770</c> for every
/// dialog, <c>#32768</c> for a menu).</item>
/// </list>
/// A text the importer would refuse is left out.
/// </summary>
public static partial class WindowRules
{
    public static RecordedWindow Window(WindowFacts window)
    {
        var exe = IsExeName(window.Exe) ? window.Exe : null;
        var title = Texts.Matchable(window.Title);
        var cls = Texts.Matchable(window.ClassName);
        if (cls is null || cls.StartsWith("WindowsForms10.", StringComparison.Ordinal) || cls.StartsWith("HwndWrapper[", StringComparison.Ordinal) || !StableIds.IsStable(cls))
            return new(exe, title, null);
        return cls.StartsWith('#') ? new(exe, title, cls) : new(exe, null, cls);
    }

    /// <summary>A program's file name as the importer takes it: no folder, drive, wildcard or control character, ending in
    /// .exe (EXE_NAME in packages/engine/src/import/recording.ts).</summary>
    [GeneratedRegex(@"^(?![ .])[^\\/:*?""<>|\p{Cc}]{0,251}\.exe\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ExeName();

    internal static bool IsExeName(string name) => ExeName().IsMatch(name) && !name.Contains("{{");

    /// <summary>The file name at the end of a Windows or a / path.</summary>
    internal static string FileName(string path) => path[(path.LastIndexOfAny(['\\', '/']) + 1)..];
}
