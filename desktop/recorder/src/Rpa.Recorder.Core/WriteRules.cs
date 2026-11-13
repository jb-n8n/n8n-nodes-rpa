using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core;

/// <summary>
/// Which clicked controls the policy change file proposes to protect as write controls. A click is proposed by the
/// engine's own rule, the one that pre-ticks the review page's "Which of these steps save, send or submit?"
/// (<c>looksLikeWrite</c> in packages/engine/src/proposal/desktop.ts), so what is ticked and what is protected match:
/// a word such as save, post or submit in the step's label (as the intent holds it, after the importer's
/// <c>cleanLabel</c>) or in the name or automation id of a condition of its locator. A test holds the words and the
/// way they are read to the engine's. Keys are never proposed.
/// <para>
/// The ids 1 to 11 are those of Windows' standard dialog buttons (OK, Cancel, Yes, No and the like), and a task dialog
/// (such as "Confirm Save As") names the same buttons CommandButton_1 to CommandButton_11: every dialog and message box
/// of an app has them, so protecting one would gate them all. Such a control is left out, and the change file names it
/// (<see cref="IsDialogButtonId"/>, the policy tool's rule).
/// </para>
/// </summary>
public static partial class WriteRules
{
    /// <summary>The engine's WRITE_WORDS, in its order.</summary>
    public const string Words = "save|post|posting|submit|send|delete|remove|approve|release|book|pay|transfer|apply|confirm|commit|update|create|ok|yes";

    /// <summary>The importer's MAX_LABEL: the most of a label an intent holds, in code points.</summary>
    public const int MaxLabel = 80;

    // ECMAScript: \b and the classes as JavaScript reads them (a word character is [A-Za-z0-9_]).
    [GeneratedRegex(@"\b(" + Words + @")\b", RegexOptions.ECMAScript)] private static partial Regex WriteWord();
    [GeneratedRegex("([a-z0-9])([A-Z])", RegexOptions.ECMAScript)] private static partial Regex Hump();
    [GeneratedRegex(@"[_.\-]+", RegexOptions.ECMAScript)] private static partial Regex Separators();
    [GeneratedRegex(@"^(?:CommandButton_)?(?:[1-9]|1[01])\z", RegexOptions.ECMAScript)] private static partial Regex DialogButton();

    /// <summary>The engine's <c>words</c>: <c>btnPost</c> -> <c>btn Post</c>, <c>save_as</c> -> <c>save as</c>.</summary>
    public static string SplitWords(string text) => Separators().Replace(Hump().Replace(text, "$1 $2"), " ");

    /// <summary>The engine's <c>WRITE_WORDS.test</c>: case-insensitive for ASCII letters only, as a JavaScript /i
    /// pattern of ASCII words without the u flag is.</summary>
    public static bool HasWriteWord(string text)
    {
        var lower = new StringBuilder(text.Length);
        foreach (var c in text) lower.Append(c is >= 'A' and <= 'Z' ? (char)(c + 32) : c);
        return WriteWord().IsMatch(lower.ToString());
    }

    /// <summary>Whether a recorded click (or double click) looks like a write, as the engine judges the step it becomes.</summary>
    public static bool LooksLikeWrite(RecordedStep step)
    {
        if (step.Kind != StepKind.Click || step.Target is not { } target) return false;
        // The importer keeps only stable ids, as the recorder records them: a condition's id here is one the step keeps.
        var locator = string.Join(' ', target.Path.Select(c => $"{c.Name ?? ""} {SplitWords(c.AutomationId ?? "")}"));
        return HasWriteWord(SplitWords(CleanLabel(step.Label))) || HasWriteWord(locator);
    }

    /// <summary>The policy tool's <c>IsDialogButtonId</c> twin: one of Windows' standard dialog button ids, 1 to 11, or
    /// CommandButton_1 to CommandButton_11 in a task dialog.</summary>
    public static bool IsDialogButtonId(string automationId) => DialogButton().IsMatch(automationId);

    // JavaScript's \s, every code point of it (as StableIds spells it out).
    private const string Space = @"[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]";
    [GeneratedRegex(Space + "+")] private static partial Regex Spaces();
    [GeneratedRegex("^" + Space + "+|" + Space + "+$")] private static partial Regex Ends();

    /// <summary>The importer's <c>cleanLabel</c>: format characters and lone surrogates out, control characters as
    /// spaces, runs of spaces as one, trimmed, and at most <see cref="MaxLabel"/> code points.</summary>
    private static string CleanLabel(string label)
    {
        var kept = new StringBuilder(label.Length);
        for (var i = 0; i < label.Length; i++)
        {
            var c = label[i];
            if (char.IsHighSurrogate(c) && i + 1 < label.Length && char.IsLowSurrogate(label[i + 1]))
            {
                if (CharUnicodeInfo.GetUnicodeCategory(char.ConvertToUtf32(c, label[i + 1])) != UnicodeCategory.Format) kept.Append(c).Append(label[i + 1]);
                i++;
                continue;
            }
            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.Format or UnicodeCategory.Surrogate) continue;
            kept.Append(category == UnicodeCategory.Control || c is '\u2028' or '\u2029' ? ' ' : c);
        }
        var text = Ends().Replace(Spaces().Replace(kept.ToString(), " "), "");
        var runes = text.EnumerateRunes().ToList();
        return runes.Count <= MaxLabel ? text : Ends().Replace(string.Concat(runes.Take(MaxLabel)), "");
    }
}
