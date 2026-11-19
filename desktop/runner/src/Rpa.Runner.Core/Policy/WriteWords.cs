using System.Text;
using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Policy;

/// <summary>
/// The engine's write words (WRITE_WORDS in packages/engine/src/proposal/desktop.ts, the recorder's WriteRules.Words):
/// a name or automation id that reads like save, post, submit and the like. Repair and probe acts are refused on such a
/// control, and a probe click is refused in a window whose title or static text has one. A hint, not a proof: a write
/// control named otherwise is caught only by the policy's writeControls.
/// </summary>
public static partial class WriteWords
{
    public const string Words = "save|post|posting|submit|send|delete|remove|approve|release|book|pay|transfer|apply|confirm|commit|update|create|ok|yes";

    // ECMAScript: \b and the classes as JavaScript reads them (a word character is [A-Za-z0-9_]).
    [GeneratedRegex(@"\b(" + Words + @")\b", RegexOptions.ECMAScript)] private static partial Regex WriteWord();
    [GeneratedRegex("([a-z0-9])([A-Z])", RegexOptions.ECMAScript)] private static partial Regex Hump();
    [GeneratedRegex(@"[_.\-]+", RegexOptions.ECMAScript)] private static partial Regex Separators();

    /// <summary>The engine's <c>words</c>: <c>btnPost</c> -> <c>btn Post</c>, <c>save_as</c> -> <c>save as</c>.</summary>
    public static string SplitWords(string text) => Separators().Replace(Hump().Replace(text, "$1 $2"), " ");

    /// <summary>Whether the text, read as words (<see cref="SplitWords"/>), has a write word: case-insensitive for ASCII
    /// letters only, as the engine's JavaScript pattern is.</summary>
    public static bool Has(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        var split = SplitWords(text);
        var lower = new StringBuilder(split.Length);
        foreach (var c in split) lower.Append(c is >= 'A' and <= 'Z' ? (char)(c + 32) : c);
        return WriteWord().IsMatch(lower.ToString());
    }
}
