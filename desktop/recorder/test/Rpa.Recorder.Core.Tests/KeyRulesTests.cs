using System.Text.RegularExpressions;
using Rpa.Runner.Core.Policy;
using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

public class KeyRulesTests
{
    private const int Enter = 0x0D, Tab = 0x09, Escape = 0x1B, F1 = 0x70, F5 = 0x74, F24 = 0x87, Backspace = 0x08, Delete = 0x2E;
    private const int Left = 0x25, Down = 0x28, Home = 0x24, Space = 0x20, A = 0x41, C = 0x43, E = 0x45, F = 0x46, Q = 0x51, S = 0x53, V = 0x56;
    private const int Digit1 = 0x31, Numpad1 = 0x61, OemPlus = 0xBB;

    private static readonly ElementFacts TextBox = El("Edit", "txtName", "Name");
    private static readonly ElementFacts DropDownList = El("ComboBox", "cmbCompany", "Company code");
    private static readonly ElementFacts EditableCombo = El("ComboBox", "cmbCity", "City", editChild: true);
    private static readonly ElementFacts Grid = El("DataGrid", "gridResults", "Results");

    /// <summary>The chord a key makes on the focused element, or null when it is typing (or dropped).</summary>
    private static string? Event(int vk, bool ctrl, bool alt, bool shift, ElementFacts focused)
    {
        var kind = KeyRules.Kind(vk, ctrl, alt);
        if (kind is KeyKind.Modifier or KeyKind.Printable || KeyRules.IsTyping(kind, KeyRules.Field(focused))) return null;
        return KeyRules.Chord(ctrl, alt, shift, KeyRules.KeyName(vk)!);
    }

    [Fact]
    public void Enter_Tab_Shift_Tab_Escape_and_F1_to_F24_are_key_events()
    {
        foreach (var focused in new[] { TextBox, DropDownList, Grid })
        {
            Assert.Equal("Enter", Event(Enter, false, false, false, focused));
            Assert.Equal("Tab", Event(Tab, false, false, false, focused));
            Assert.Equal("Shift+Tab", Event(Tab, false, false, true, focused));
            Assert.Equal("Escape", Event(Escape, false, false, false, focused));
            Assert.Equal("F1", Event(F1, false, false, false, focused));
            Assert.Equal("F5", Event(F5, false, false, false, focused));
            Assert.Equal("F24", Event(F24, false, false, false, focused));
        }
    }

    [Fact]
    public void Ctrl_or_Alt_chords_other_than_the_editing_ones_are_key_events_in_the_canonical_spelling()
    {
        Assert.Equal("Ctrl+F", Event(F, true, false, false, TextBox));
        Assert.Equal("Ctrl+S", Event(S, true, false, false, Grid));
        Assert.Equal("Ctrl+Shift+S", Event(S, true, false, true, TextBox));
        Assert.Equal("Alt+F", Event(F, false, true, false, TextBox));
        Assert.Equal("Alt+Shift+F5", Event(F5, false, true, true, Grid));
        Assert.Equal("Ctrl+1", Event(Digit1, true, false, false, Grid));
        Assert.Equal("Ctrl+Alt+Shift+S", KeyRules.Chord(true, true, true, "S"));
    }

    [Fact]
    public void Editing_keys_and_chords_are_typing_in_a_text_field_and_key_events_elsewhere()
    {
        foreach (var (vk, ctrl) in new[] { (A, true), (C, true), (V, true), (Backspace, true), (Left, true), (Backspace, false), (Delete, false), (Left, false), (Home, false) })
        {
            Assert.Null(Event(vk, ctrl, false, false, TextBox));
            Assert.Null(Event(vk, ctrl, false, true, EditableCombo));
            Assert.NotNull(Event(vk, ctrl, false, false, Grid));
        }
        Assert.Equal("Ctrl+C", Event(C, true, false, false, Grid));
        Assert.Equal("Down", Event(Down, false, false, false, Grid));
    }

    [Fact]
    public void Arrow_keys_in_a_drop_down_list_change_its_selection_and_its_editing_chords_are_key_events()
    {
        Assert.Equal(FieldKind.DropDown, KeyRules.Field(DropDownList));
        Assert.True(KeyRules.IsTyping(KeyRules.Kind(Down, false, false), FieldKind.DropDown));
        Assert.True(KeyRules.IsTyping(KeyRules.Kind(A, false, false), FieldKind.DropDown));
        Assert.Equal("Ctrl+C", Event(C, true, false, false, DropDownList));
    }

    [Fact]
    public void An_editable_ComboBox_is_decided_by_HasEditChild()
    {
        Assert.Equal(FieldKind.Text, KeyRules.Field(EditableCombo));
        Assert.Equal(FieldKind.DropDown, KeyRules.Field(DropDownList));
        Assert.Equal(FieldKind.Text, KeyRules.Field(El("Document", "15", "Text editor")));
        Assert.Equal(FieldKind.Text, KeyRules.Field(El("Custom", "", "", password: true)));
        Assert.Equal(FieldKind.None, KeyRules.Field(Grid));
    }

    [Fact]
    public void Printable_keys_are_typing_in_a_field_and_never_a_key_event()
    {
        foreach (var vk in new[] { A, Digit1, Space, Numpad1, OemPlus })
        {
            Assert.Equal(KeyKind.Printable, KeyRules.Kind(vk, false, false));
            Assert.True(KeyRules.IsTyping(KeyKind.Printable, FieldKind.Text));
            Assert.Null(Event(vk, false, false, true, Grid));
        }
        // Ctrl or Alt with a key the runner cannot press, such as Alt with numpad digits (which types a character).
        Assert.Equal(KeyKind.Printable, KeyRules.Kind(Numpad1, false, true));
        Assert.Equal(KeyKind.Printable, KeyRules.Kind(OemPlus, true, false));
    }

    // AltGr is Ctrl+Alt: on many keyboards it types @, \ or { into a password, also into a password box the recorder
    // does not take for a text field.

    [Fact]
    public void Ctrl_Alt_with_a_letter_on_an_element_that_is_not_a_field_is_dropped_not_a_key_step()
    {
        foreach (var vk in new[] { Q, Digit1, Space, OemPlus })
        {
            Assert.Equal(KeyKind.Printable, KeyRules.Kind(vk, true, true));
            Assert.Null(Event(vk, true, true, false, Grid));
            Assert.Null(Event(vk, true, true, true, Grid));
        }
    }

    [Fact]
    public void Ctrl_Alt_with_a_letter_in_a_text_field_is_typing()
    {
        Assert.True(KeyRules.IsTyping(KeyRules.Kind(Q, true, true), KeyRules.Field(TextBox)));
        Assert.True(KeyRules.IsTyping(KeyRules.Kind(Q, true, true), KeyRules.Field(El("Edit", "txtPassword", "Password", password: true))));
    }

    [Fact]
    public void Ctrl_Alt_Delete_style_chords_with_a_non_character_key_are_unchanged()
    {
        foreach (var vk in new[] { Delete, Backspace, Left, Down, Home, 0x23, 0x2D, 0x21, 0x22 })
        {
            Assert.Equal(KeyKind.EditChord, KeyRules.Kind(vk, true, true));
            Assert.Null(Event(vk, true, true, false, TextBox));
        }
        Assert.Equal("Ctrl+Alt+Delete", Event(Delete, true, true, false, Grid));
        Assert.Equal("Ctrl+Alt+F5", Event(F5, true, true, false, Grid));
    }

    [Fact]
    public void Every_key_event_the_recorder_writes_is_a_chord_the_runner_reads_back_with_a_key_name_of_the_engine()
    {
        // The engine's key names (KEY_NAMES in desktop-vocabulary.ts), besides letters, digits and F1 to F24.
        var ts = RepoFile("packages", "engine", "src", "steps", "desktop-vocabulary.ts");
        var names = Regex.Matches(Regex.Match(ts, @"const KEY_NAMES\b[^{]*\{(?<b>[^}]*)\}").Groups["b"].Value, @":\s*'(?<n>[A-Za-z]+)'")
            .Select(m => m.Groups["n"].Value).ToHashSet();
        Assert.Contains("PageDown", names);
        var written = 0;
        for (var vk = 0; vk < 256; vk++)
        {
            if (KeyRules.KeyName(vk) is not { } key) continue;
            Assert.True(names.Contains(key) || Regex.IsMatch(key, "^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$"), key);
            foreach (var (ctrl, alt, shift) in new[] { (false, false, false), (true, false, false), (false, true, false), (false, false, true),
                         (true, true, false), (true, false, true), (false, true, true), (true, true, true) })
            {
                if (KeyRules.Kind(vk, ctrl, alt) is KeyKind.Modifier or KeyKind.Shell or KeyKind.Printable) continue;
                var chord = KeyRules.Chord(ctrl, alt, shift, key);
                Assert.Equal(chord, KeyChord.Parse(chord).ToString());
                written++;
            }
        }
        Assert.True(written > 100, $"{written} chords");
    }

    [Fact]
    public void Modifier_keys_alone_are_ignored()
    {
        foreach (var vk in new[] { 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C, 0x14, 0x90, 0x91 })
            Assert.Equal(KeyKind.Modifier, KeyRules.Kind(vk, true, false));
    }

    [Fact]
    public void Keys_that_belong_to_Windows_are_never_recorded()
    {
        // Alt+Tab, Alt+Shift+Tab, Ctrl+Alt+Tab, Alt+Escape, Ctrl+Escape, Ctrl+Shift+Escape, and any chord with the Windows
        // key (Win+Tab, Win+E, Win+Left).
        foreach (var (vk, ctrl, alt, win) in new[] { (Tab, false, true, false), (Tab, true, true, false), (Escape, false, true, false),
            (Escape, true, false, false), (Escape, true, true, false), (Tab, false, false, true), (E, false, false, true), (Left, false, false, true), (S, true, false, true) })
        {
            Assert.Equal(KeyKind.Shell, KeyRules.Kind(vk, ctrl, alt, win));
            Assert.False(KeyRules.IsTyping(KeyKind.Shell, FieldKind.Text));
        }
        foreach (var (vk, ctrl) in new[] { (Tab, false), (Tab, true), (Escape, false) }) Assert.Equal(KeyKind.Command, KeyRules.Kind(vk, ctrl, false, false));
    }

    [Fact]
    public void The_shell_chords_are_the_step_parsers()
    {
        // The engine refuses them in a step (isShellChord); the recorder's rule above is that rule, word for word.
        var ts = RepoFile("packages", "engine", "src", "steps", "desktop-vocabulary.ts");
        Assert.Contains("return (mods.has('Ctrl') && key === 'Escape') || (mods.has('Alt') && (key === 'Tab' || key === 'Escape'));", ts);
        Assert.Contains("if (mods.some((m) => /^(win|windows|meta)$/i.test(m))) return 'is a Windows-key shortcut", ts);
    }
}
