namespace Rpa.Recorder.Core;

/// <summary>What a key is when the hook sees it, before the focused element is known.</summary>
public enum KeyKind
{
    /// <summary>Ctrl, Alt, Shift, Win and the lock keys alone: ignored.</summary>
    Modifier,
    /// <summary>A key that types a character (letters, digits, Space, punctuation, Alt with numpad digits), or a chord the
    /// runner has no name for: typing in a field, dropped elsewhere. Never a key event.</summary>
    Printable,
    /// <summary>Backspace, Delete, Insert, the arrows, Home, End, PageUp, PageDown: typing in a field (in a drop-down list
    /// they change its selection), a key event elsewhere.</summary>
    Navigation,
    /// <summary>The editing chords (Ctrl with A, C, V, X, Z, Y, Insert, Backspace, Delete, the arrows, Home, End) and
    /// Ctrl+Alt chords (AltGr types characters on many keyboards): typing in a text field, a key event elsewhere.</summary>
    EditChord,
    /// <summary>Enter, Tab, Escape, F1 to F24, and the other Ctrl or Alt chords: always a key event.</summary>
    Command,
}

/// <summary>What the focused element does with typing.</summary>
public enum FieldKind { None, Text, DropDown }

/// <summary>
/// Which keys are typing and which are key events. Typing is never recorded as keys: the field's text is read when the
/// person leaves it. A key event is spelled the way the runner's key chords are (modifiers in the order Ctrl, Alt,
/// Shift; the runner's key names).
/// </summary>
public static class KeyRules
{
    /// <summary>The runner's name for a virtual-key code, or null when it has none.</summary>
    public static string? KeyName(int vk) => vk switch
    {
        0x0D => "Enter", 0x09 => "Tab", 0x1B => "Escape", 0x20 => "Space", 0x08 => "Backspace", 0x2E => "Delete",
        0x2D => "Insert", 0x24 => "Home", 0x23 => "End", 0x21 => "PageUp", 0x22 => "PageDown",
        0x26 => "Up", 0x28 => "Down", 0x25 => "Left", 0x27 => "Right",
        >= 0x70 and <= 0x87 => $"F{vk - 0x6F}",
        >= 0x30 and <= 0x39 or >= 0x41 and <= 0x5A => ((char)vk).ToString(),
        _ => null,
    };

    public static KeyKind Kind(int vk, bool ctrl, bool alt)
    {
        if (vk is 0x10 or 0x11 or 0x12 or >= 0xA0 and <= 0xA5 or 0x5B or 0x5C or 0x14 or 0x90 or 0x91) return KeyKind.Modifier;
        if (vk is 0x0D or 0x09 or 0x1B or >= 0x70 and <= 0x87) return KeyKind.Command;
        var named = KeyName(vk) is not null;
        if (ctrl && alt) return named ? KeyKind.EditChord : KeyKind.Printable;
        if (ctrl && vk is 0x41 or 0x43 or 0x56 or 0x58 or 0x5A or 0x59 or 0x2D or 0x08 or 0x2E or >= 0x23 and <= 0x28) return KeyKind.EditChord;
        if (ctrl || alt) return named ? KeyKind.Command : KeyKind.Printable;
        return vk is 0x08 or 0x2E or 0x2D or >= 0x21 and <= 0x28 ? KeyKind.Navigation : KeyKind.Printable;
    }

    /// <summary>A key event's chord in the canonical spelling: <c>Ctrl+Alt+Shift+Key</c>, each modifier only when held.</summary>
    public static string Chord(bool ctrl, bool alt, bool shift, string key) =>
        string.Concat(ctrl ? "Ctrl+" : "", alt ? "Alt+" : "", shift ? "Shift+" : "", key);

    /// <summary>A password field or a text field (an Edit, a Document, a ComboBox holding an Edit) takes text; a ComboBox
    /// without an Edit is a drop-down list.</summary>
    public static FieldKind Field(ElementFacts element) => element switch
    {
        { IsPassword: true } or { ControlType: "Edit" or "Document" } => FieldKind.Text,
        { ControlType: "ComboBox", HasEditChild: true } => FieldKind.Text,
        { ControlType: "ComboBox" } => FieldKind.DropDown,
        _ => FieldKind.None,
    };

    /// <summary>Whether a key of this kind, on a focused element of this kind, is typing.</summary>
    public static bool IsTyping(KeyKind kind, FieldKind field) => kind switch
    {
        KeyKind.Printable or KeyKind.Navigation => field != FieldKind.None,
        KeyKind.EditChord => field == FieldKind.Text,
        _ => false,
    };
}
