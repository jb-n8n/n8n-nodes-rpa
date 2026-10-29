using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Policy;

/// <summary>
/// A key chord such as <c>Enter</c>, <c>Tab</c>, <c>Ctrl+S</c>, <c>Ctrl+Shift+F5</c>. Normalised so that gated-key checks
/// do not depend on spelling: modifiers in the order Ctrl, Alt, Shift, Win; key names in a canonical case.
/// </summary>
public sealed record KeyChord(bool Ctrl, bool Alt, bool Shift, bool Win, string Key)
{
    private static readonly Dictionary<string, string> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = "Enter", ["return"] = "Enter", ["tab"] = "Tab", ["escape"] = "Escape", ["esc"] = "Escape",
        ["space"] = "Space", ["backspace"] = "Backspace", ["delete"] = "Delete", ["del"] = "Delete",
        ["insert"] = "Insert", ["ins"] = "Insert", ["home"] = "Home", ["end"] = "End", ["pageup"] = "PageUp",
        ["pgup"] = "PageUp", ["pagedown"] = "PageDown", ["pgdn"] = "PageDown", ["up"] = "Up", ["down"] = "Down",
        ["left"] = "Left", ["right"] = "Right", ["arrowup"] = "Up", ["arrowdown"] = "Down", ["arrowleft"] = "Left",
        ["arrowright"] = "Right", ["apps"] = "Apps", ["menu"] = "Apps",
    };

    public static KeyChord Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) throw RpcErrors.InvalidParamsError("key chord is empty");
        var parts = text.Split('+', StringSplitOptions.TrimEntries);
        if (parts.Any(p => p.Length == 0))
            throw RpcErrors.InvalidParamsError("key chord is not of the form Ctrl+Shift+Key");
        // Canonical form: modifiers are flags (a chord ending in a modifier, such as "Alt" or "Ctrl+Shift", folds it into
        // the flags and has an empty key), each modifier at most once, so every spelling of a chord compares equal.
        bool ctrl = false, alt = false, shift = false, win = false;
        for (var i = 0; i < parts.Length; i++)
        {
            var m = ModifierOf(parts[i]);
            if (m is null)
            {
                if (i < parts.Length - 1) throw RpcErrors.InvalidParamsError("key chord has an unknown modifier");
                return new KeyChord(ctrl, alt, shift, win, NormaliseKey(parts[i]));
            }
            ref var flag = ref ctrl;
            switch (m)
            {
                case 'A': flag = ref alt; break;
                case 'S': flag = ref shift; break;
                case 'W': flag = ref win; break;
            }
            if (flag) throw RpcErrors.InvalidParamsError("key chord names a modifier twice");
            flag = true;
        }
        return new KeyChord(ctrl, alt, shift, win, "");
    }

    /// <summary>True when the chord is modifiers only (for example Alt, which opens the menu bar).</summary>
    public bool ModifiersOnly => Key.Length == 0;

    private static char? ModifierOf(string part) => part.ToLowerInvariant() switch
    {
        "ctrl" or "control" => 'C',
        "alt" => 'A',
        "shift" => 'S',
        "win" or "meta" or "windows" => 'W',
        _ => null,
    };

    private static string NormaliseKey(string key)
    {
        if (Named.TryGetValue(key, out var n)) return n;
        if (key.Length == 1 && char.IsAsciiLetterOrDigit(key[0])) return key.ToUpperInvariant();
        if ((key[0] is 'F' or 'f') && int.TryParse(key.AsSpan(1), out var f) && f is >= 1 and <= 24) return "F" + f;
        throw RpcErrors.InvalidParamsError("key chord names an unknown key");
    }

    public override string ToString()
    {
        var parts = new List<string>();
        if (Ctrl) parts.Add("Ctrl");
        if (Alt) parts.Add("Alt");
        if (Shift) parts.Add("Shift");
        if (Win) parts.Add("Win");
        if (Key.Length > 0) parts.Add(Key);
        return string.Join('+', parts);
    }
}
