using System.Globalization;
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

    /// <summary>Whether the text, read as words (<see cref="SplitWords"/>) and folded as the destructive list folds it
    /// (<see cref="DestructiveWords.Normalize"/>: look-alike letters, accents, invisible characters, full-width forms,
    /// lower case), has a write word: the engine's hasWriteWord does the same.</summary>
    public static bool Has(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        return WriteWord().IsMatch(DestructiveWords.Normalize(SplitWords(text)));
    }
}

/// <summary>
/// The engine's destructive denylist (DENYLIST in packages/engine/src/policy/destructive.ts, word for word) plus
/// "discard", which desktop dialogs use where web pages say delete. Probe mode refuses a control whose name or automation
/// id (read as words, btnReject -> btn Reject) matches it. Kept apart from <see cref="WriteWords"/>, which stays the
/// recorder's list.
/// </summary>
public static partial class DestructiveWords
{
    /// <summary>The engine's pattern, as written there.</summary>
    public const string EnginePattern =
        "(?<![a-z])((?:delete|remove|acknowledge|ack|approve|reject|cancel|archive|confirm|pay|payment|send|transfer|deactivate|revoke|purge|destroy|refund|unsubscribe)(?: ?all)?"
        + "|log ?out|log ?off|sign ?out|cancel ?order|submit ?order)(?![a-z])";

    /// <summary>The probe list: the engine's pattern with discard added.</summary>
    public const string Pattern =
        "(?<![a-z])((?:delete|remove|acknowledge|ack|approve|reject|cancel|archive|confirm|pay|payment|send|transfer|deactivate|revoke|purge|destroy|refund|unsubscribe)(?: ?all)?"
        + "|log ?out|log ?off|sign ?out|cancel ?order|submit ?order|discard(?: ?all| ?changes)?)(?![a-z])";

    [GeneratedRegex(Pattern, RegexOptions.CultureInvariant)] private static partial Regex Destructive();

    /// <summary>Whether the text names a destructive action: the text, and the text read as words (<see
    /// cref="WriteWords.SplitWords"/>), each normalized as the engine's normalizeForDenylist does (<see cref="Normalize"/>),
    /// so a zero-width character, a soft hyphen, a homoglyph, an accent or a full-width letter does not hide the word.</summary>
    public static bool Has(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        return Destructive().IsMatch(Normalize(text)) || Destructive().IsMatch(Normalize(WriteWords.SplitWords(text)));
    }

    /// <summary>The engine's INVISIBLE (packages/engine/src/policy/destructive.ts): soft hyphen, zero-width space, joiners,
    /// word joiner, byte order mark.</summary>
    public static bool IsInvisible(Rune r) => r.Value is 0x00AD or (>= 0x200B and <= 0x200D) or 0x2060 or 0xFEFF;

    /// <summary>The engine's HOMOGLYPHS, entry for entry: Cyrillic and Greek letters that render like Latin ones.</summary>
    public static readonly IReadOnlyDictionary<char, char> Homoglyphs = new Dictionary<char, char>
    {
        ['\u0430'] = 'a', ['\u0432'] = 'b', ['\u0435'] = 'e', ['\u0451'] = 'e', ['\u043a'] = 'k', ['\u043c'] = 'm', ['\u043d'] = 'h',
        ['\u043e'] = 'o', ['\u0440'] = 'p', ['\u0441'] = 'c', ['\u0442'] = 't', ['\u0443'] = 'y', ['\u0445'] = 'x', ['\u0456'] = 'i',
        ['\u0457'] = 'i', ['\u0458'] = 'j', ['\u0455'] = 's', ['\u0501'] = 'd', ['\u051b'] = 'q', ['\u051d'] = 'w', ['\u04cf'] = 'l',
        ['\u04bb'] = 'h', ['\u0410'] = 'A', ['\u0412'] = 'B', ['\u0415'] = 'E', ['\u0401'] = 'E', ['\u041a'] = 'K', ['\u041c'] = 'M',
        ['\u041d'] = 'H', ['\u041e'] = 'O', ['\u0420'] = 'P', ['\u0421'] = 'C', ['\u0422'] = 'T', ['\u0423'] = 'Y', ['\u0425'] = 'X',
        ['\u0406'] = 'I', ['\u0408'] = 'J', ['\u0405'] = 'S', ['\u0500'] = 'D', ['\u04c0'] = 'I', ['\u03b1'] = 'a', ['\u03b5'] = 'e',
        ['\u03b9'] = 'i', ['\u03ba'] = 'k', ['\u03bd'] = 'v', ['\u03bf'] = 'o', ['\u03c1'] = 'p', ['\u03c4'] = 't', ['\u03c5'] = 'u',
        ['\u03c7'] = 'x', ['\u03f2'] = 'c', ['\u0391'] = 'A', ['\u0392'] = 'B', ['\u0395'] = 'E', ['\u0396'] = 'Z', ['\u0397'] = 'H',
        ['\u0399'] = 'I', ['\u039a'] = 'K', ['\u039c'] = 'M', ['\u039d'] = 'N', ['\u039f'] = 'O', ['\u03a1'] = 'P', ['\u03a4'] = 'T',
        ['\u03a5'] = 'Y', ['\u03a7'] = 'X',
    };

    [GeneratedRegex(@"(\p{Ll})(\p{Lu})")] private static partial Regex LowerUpper();
    [GeneratedRegex(@"(\p{Lu})(\p{Lu}\p{Ll})")] private static partial Regex UpperUpperLower();
    [GeneratedRegex("[_\\-\u2010-\u2015]+")] private static partial Regex Dashes();
    // JavaScript's \s, character for character (.NET's own \s also takes U+0085 and leaves out U+FEFF).
    [GeneratedRegex("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")] private static partial Regex Spaces();

    /// <summary>
    /// The engine's normalizeForDenylist: per code point NFKC then NFD with combining marks dropped, invisible characters
    /// dropped and homoglyphs mapped to Latin (fold); then camelCase split, underscores and dashes (ASCII and U+2010 to
    /// U+2015) as spaces, whitespace collapsed, lower case.
    /// </summary>
    public static string Normalize(string text)
    {
        var folded = new StringBuilder(text.Length);
        foreach (var r in text.EnumerateRunes())
        {
            if (IsInvisible(r)) continue;
            string decomposed;
            try { decomposed = r.ToString().Normalize(NormalizationForm.FormKC).Normalize(NormalizationForm.FormD); }
            catch (ArgumentException) { decomposed = r.ToString(); }
            foreach (var f in decomposed.EnumerateRunes())
            {
                var cat = Rune.GetUnicodeCategory(f);
                if (cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark) continue;
                if (f.IsBmp && Homoglyphs.TryGetValue((char)f.Value, out var latin)) folded.Append(latin);
                else folded.Append(f.ToString());
            }
        }
        var s = UpperUpperLower().Replace(LowerUpper().Replace(folded.ToString(), "$1 $2"), "$1 $2");
        return Spaces().Replace(Dashes().Replace(s, " "), " ").ToLowerInvariant();
    }
}
