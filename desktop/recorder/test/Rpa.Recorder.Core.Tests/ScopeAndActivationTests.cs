using System.Text.Json;
using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>Which input belongs to the recording, the password flag that cannot be read, Space on a check box or a
/// button, and the double-click.</summary>
public class ScopeAndActivationTests
{
    private const string Program = @"C:\Apps\Orders.exe";
    private static readonly DateTimeOffset Start = T0;
    private static readonly ProcessFacts App = new(100, 4, Program, Start);

    private static Func<int, ProcessFacts?> Processes(params ProcessFacts[] list) => id => list.FirstOrDefault(p => p.Id == id);

    [Fact]
    public void Input_is_in_scope_only_in_the_recorded_application_its_children_and_other_processes_of_its_program()
    {
        var scope = new AppScope(App, Program);
        var child = new ProcessFacts(200, 100, @"C:\Apps\Helper\viewer.exe", Start.AddSeconds(5));
        var grandchild = new ProcessFacts(300, 200, @"C:\Windows\System32\msedgewebview2.exe", Start.AddSeconds(6));
        var second = new ProcessFacts(400, 4, @"c:\apps\ORDERS.EXE", Start.AddSeconds(9));
        var browser = new ProcessFacts(500, 4, @"C:\Program Files\Browser\browser.exe", Start.AddSeconds(1));
        var lookup = Processes(App, child, grandchild, second, browser);

        Assert.True(scope.Includes(100, lookup));
        Assert.True(scope.Includes(200, lookup));
        Assert.True(scope.Includes(300, lookup));
        Assert.True(scope.Includes(400, lookup));
        Assert.False(scope.Includes(500, lookup));
        Assert.False(scope.Includes(999, lookup), "a process that cannot be looked at is out of scope");
    }

    [Fact]
    public void A_process_whose_path_cannot_be_read_or_whose_parent_id_was_reused_is_out_of_scope()
    {
        var scope = new AppScope(App, Program);
        var noPath = new ProcessFacts(200, 100, null, Start.AddSeconds(5));
        // Its parent id is the application's, but it started before the application: that id belonged to another process.
        var older = new ProcessFacts(300, 100, @"C:\Tools\tool.exe", Start.AddSeconds(-60));
        var noTime = new ProcessFacts(400, 100, @"C:\Tools\tool.exe", null);
        var lookup = Processes(App, noPath, older, noTime);
        Assert.False(scope.Includes(200, lookup));
        Assert.False(scope.Includes(300, lookup));
        Assert.False(scope.Includes(400, lookup));
    }

    [Fact]
    public void A_password_flag_that_cannot_be_read_counts_as_set()
    {
        Assert.True(SecretRules.PasswordFlag(null));
        Assert.True(SecretRules.PasswordFlag(true));
        Assert.False(SecretRules.PasswordFlag(false));
        var field = El("Edit", "txtCode", "Code");
        Assert.False(SecretRules.IsSecret(field, flagNow: false));
        Assert.True(SecretRules.IsSecret(field, flagNow: null));
        Assert.True(SecretRules.IsSecret(field, flagNow: true));
        Assert.True(SecretRules.IsSecret(El("Edit", "txtPassword", "Password"), flagNow: false));

        // The Windows layer passes the field with the flag set: the fill is the variable, marked secret.
        var typed = NewSecret();
        var s = Record(Typed(1, field), Left(2, field with { IsPassword = true }, typed));
        Assert.Equal(("{{var.code}}", true), (s.Steps[0].Value, s.Steps[0].Secret));
        Assert.False(StringsIn(s).Any(x => x.Contains(typed)), "the typed value is kept in the session");
    }

    [Fact]
    public void Space_on_a_check_box_a_radio_button_or_a_button_is_what_a_click_on_it_records()
    {
        Assert.True(KeyRules.MayActivate(0x20, false, false, fieldBeingTyped: false));
        Assert.False(KeyRules.MayActivate(0x20, true, false, fieldBeingTyped: false));
        Assert.False(KeyRules.MayActivate(0x41, false, false, fieldBeingTyped: false));
        foreach (var type in new[] { "CheckBox", "RadioButton", "Button" }) Assert.True(KeyRules.Activates(El(type, "x", "X")));
        foreach (var type in new[] { "Edit", "Document", "ComboBox", "DataItem", "Custom" }) Assert.False(KeyRules.Activates(El(type, "x", "X")));
        Assert.False(KeyRules.Activates(El("Button", "x", "X", password: true)));

        var box = El("CheckBox", "chkAll", "All companies") with { IsChecked = false };
        var s = Record(new Activated(At(1), Window, box), new Activated(At(2), Window, El("Button", "btnOk", "OK")), new Activated(At(3), Window, El("RadioButton", "optDaily", "Daily") with { IsChecked = false }));
        Assert.Equal(["Check All companies", "Click OK", "Click Daily"], s.Steps.Select(StepText.Sentence));
        Assert.True(s.Steps[0].Checked);
    }

    [Fact]
    public void Space_while_typing_into_a_field_is_typing_and_does_not_ask_what_has_the_focus()
    {
        var name = El("Edit", "txtName", "Name");
        var s = Record(Typed(1, name));
        Assert.False(KeyRules.MayActivate(0x20, false, false, s.FieldBeingTyped is not null));
        Assert.Equal(KeyKind.Printable, KeyRules.Kind(0x20, false, false));
        s.Add(Left(2, name, "Ada Lovelace"));
        Assert.True(KeyRules.MayActivate(0x20, false, false, s.FieldBeingTyped is not null));
    }

    [Fact]
    public void After_the_recorded_process_exits_its_id_is_not_in_scope()
    {
        var scope = new AppScope(App, Program);
        var child = new ProcessFacts(200, 100, @"C:\Apps\Helper\viewer.exe", Start.AddSeconds(5));
        var lateChild = new ProcessFacts(300, 100, @"C:\Apps\Helper\viewer.exe", Start.AddSeconds(30));
        var other = new ProcessFacts(100, 4, @"C:\Program Files\Chat\chat.exe", Start.AddSeconds(40));
        Assert.True(scope.Includes(100, Processes(App, child, lateChild)));
        scope.AppExited(Start.AddSeconds(20));
        // The id now belongs to another program, and a process with the old parent id that started after the exit is
        // that program's child.
        Assert.False(scope.Includes(100, Processes(other, child, lateChild)));
        Assert.False(scope.Includes(300, Processes(other, child, lateChild)));
        Assert.True(scope.Includes(200, Processes(other, child, lateChild)), "a child the application started before it ended");
    }

    [Fact]
    public void A_new_process_of_the_same_program_file_is_still_in_scope_after_that()
    {
        var scope = new AppScope(App, Program);
        scope.AppExited(Start.AddSeconds(20));
        var again = new ProcessFacts(600, 4, Program, Start.AddSeconds(30));
        Assert.True(scope.Includes(600, Processes(again)));
        Assert.False(scope.Includes(100, Processes(again)));
    }

    [Fact]
    public void Space_on_a_button_leaves_the_field_being_typed_into()
    {
        var name = El("Edit", "txtName", "Name");
        var ok = El("Button", "btnOk", "OK");
        var s = Record(Typed(1, name));
        Assert.Equal(name, s.FieldLeftBy(new Activated(At(2), Window, ok)));
    }

    [Fact]
    public void Two_clicks_on_the_same_element_within_the_double_click_time_are_one_double_click()
    {
        var row = El("DataItem", "", "Acme Paper Co");
        var s = new Session { DoubleClickMs = 500 };
        s.Add(new MouseDown(At(1), Window, row, 1));
        s.Add(new MouseDown(At(1).AddMilliseconds(300), Window, row, 1));
        var step = Assert.Single(s.Steps);
        Assert.Equal((StepKind.Click, true, At(1)), (step.Kind, step.Double, step.At));
        Assert.Equal("Double-click Acme Paper Co", StepText.Sentence(step));
        // A third click is a click of its own.
        s.Add(new MouseDown(At(1).AddMilliseconds(500), Window, row, 1));
        Assert.Equal(2, s.Steps.Count);
    }

    [Fact]
    public void Two_clicks_further_apart_stay_two_clicks()
    {
        var row = El("DataItem", "", "Acme Paper Co");
        var s = new Session { DoubleClickMs = 500 };
        s.Add(new MouseDown(At(1), Window, row, 1));
        s.Add(new MouseDown(At(1).AddMilliseconds(501), Window, row, 1));
        s.Add(new MouseDown(At(1).AddMilliseconds(700), Window, El("DataItem", "", "Harbor Foods"), 1));
        Assert.Equal([false, false, false], s.Steps.Select(x => x.Double));
        // Without the system's double-click time, nothing is folded.
        var plain = Record(Click(1, row), new MouseDown(At(1).AddMilliseconds(10), Window, row, 1));
        Assert.Equal(2, plain.Steps.Count);
    }

    [Fact]
    public void A_double_click_on_a_check_box_is_not_folded()
    {
        var box = El("CheckBox", "chkAll", "All companies");
        var s = new Session { DoubleClickMs = 500 };
        s.Add(new MouseDown(At(1), Window, box with { IsChecked = false }, 1));
        s.Add(new MouseDown(At(1).AddMilliseconds(200), Window, box with { IsChecked = true }, 1));
        Assert.Equal([(StepKind.Check, true), (StepKind.Check, false)], s.Steps.Select(x => (x.Kind, x.Checked)));
    }

    [Fact]
    public void A_double_click_event_says_double_in_the_file()
    {
        var row = El("DataItem", "", "Acme Paper Co");
        var s = new Session { DoubleClickMs = 500 };
        s.Add(new MouseDown(At(1), Window, row, 1));
        s.Add(new MouseDown(At(1).AddMilliseconds(300), Window, row, 1));
        s.Add(new MouseDown(At(3), Window, El("Button", "btnOk", "OK"), 1));
        var events = JsonDocument.Parse(s.ToFile("Test").ToJson()).RootElement.GetProperty("events");
        Assert.Equal(["at", "kind", "target", "label", "double"], events[1].EnumerateObject().Select(p => p.Name));
        Assert.True(events[1].GetProperty("double").GetBoolean());
        Assert.False(events[2].TryGetProperty("double", out _));
    }
}
