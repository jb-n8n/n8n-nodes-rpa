using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>The rules the Windows program follows around the session: when a field is left, the bar's sentences, the
/// hook watch, the headless options and the saved files' names.</summary>
public class CaptureRulesTests
{
    private static readonly ElementFacts Name = El("Edit", "txtName", "Name");
    private static readonly ElementFacts City = El("Edit", "txtCity", "City");
    private static readonly ElementFacts Ok = El("Button", "btnOk", "OK");

    [Fact]
    public void The_field_being_typed_into_is_left_by_a_click_elsewhere_a_non_typing_key_or_typing_into_another_element()
    {
        var s = Record(Typed(1, Name));
        Assert.Equal(Name, s.FieldBeingTyped);
        Assert.Equal(Name, s.FieldLeftBy(Click(2, Ok)));
        Assert.Equal(Name, s.FieldLeftBy(Key(2, Name, "Enter")));
        Assert.Equal(Name, s.FieldLeftBy(Typed(2, City)));
        Assert.Null(s.FieldLeftBy(Typed(2, Name)));
        Assert.Null(new Session().FieldLeftBy(Click(2, Ok)));
    }

    [Fact]
    public void A_click_inside_the_field_being_typed_into_does_not_leave_it()
    {
        var combo = El("ComboBox", "cmbCity", "City", editChild: true);
        var s = Record(Typed(1, combo));
        Assert.Null(s.FieldLeftBy(Click(2, combo)));
        Assert.Null(s.FieldLeftBy(Click(2, El("Button", "DropDown", "Open", "", false, false, combo))));
        s.Add(Left(3, combo, "Berlin"));
        Assert.Null(s.FieldBeingTyped);
    }

    [Fact]
    public void The_bar_shows_each_step_as_a_plain_sentence_without_a_secret()
    {
        var typed = NewSecret();
        var password = El("Edit", "txtPassword", "Password", password: true);
        var box = El("CheckBox", "chkAll", "All companies") with { IsChecked = false };
        var s = Record(
            new AppStarted(At(0), @"C:\Apps\Orders.exe", [], Window),
            Typed(1, Name), Left(2, Name, "Ada"),
            Typed(3, password), Left(4, password, typed), Key(4, password, "Enter"),
            Click(5, El("ComboBox", "cmbCompany", "Company code")), Click(6, El("ListItem", "", "2000", "", false, false, El("ComboBox", "cmbCompany", "Company code"))),
            Click(7, box), Click(8, El("DataItem", "", "Vendor Row 1")), Click(9, Ok));
        s.AddRead(El("Text", "lblCount", "6 line items"), Window, "out_Count");
        Assert.Equal(
        [
            "Start Orders.exe",
            "Type \"Ada\" into Name",
            "Type the secret password into Password",
            "Press Enter in Password",
            "Choose \"2000\" in Company code",
            "Check All companies",
            "Click Vendor Row 1 (found by its row position: check it)",
            "Click OK",
            "Read 6 line items as out_Count",
        ], s.Steps.Select(StepText.Sentence));
        Assert.DoesNotContain(s.Steps.Select(StepText.Sentence), x => x.Contains(typed));

        s.MarkVariable(1, "username");
        Assert.Equal("Type the variable username into Name", StepText.Sentence(s.Steps[1]));
        var export = Record(Typed(1, El("Edit", "1001", "File name:"), new("app.exe", "Save As", "#32770")),
            Left(2, El("Edit", "1001", "File name:"), @"C:\out\report.csv", window: new("app.exe", "Save As", "#32770"))).Steps[0];
        Assert.Equal("Save report.csv into the run's export folder (File name:)", StepText.Sentence(export));
        var unchecking = Record(Click(1, box with { IsChecked = true })).Steps[0];
        Assert.Equal("Uncheck All companies", StepText.Sentence(unchecking));
        var longValue = Record(Typed(1, Name), Left(2, Name, new string('x', 100))).Steps[0];
        Assert.Equal($"Type \"{new string('x', 57)}...\" into Name", StepText.Sentence(longValue));
    }

    [Fact]
    public void A_variable_name_is_suggested_from_the_steps_field()
    {
        var s = Record(Typed(1, El("Edit", "txtDateFrom", "Date from")), Left(2, El("Edit", "txtDateFrom", "Date from"), "2026-01-20"), Click(3, Ok));
        Assert.Equal("date_from", StepText.SuggestedName(s.Steps[0]));
        Assert.True(SecretRules.IsVariableName(StepText.SuggestedName(s.Steps[0])));
    }

    [Fact]
    public void The_hook_watch_says_when_input_went_past_the_hooks()
    {
        var watch = new HookWatch();
        watch.Seen(1000);
        Assert.False(watch.Lost(lastInputMs: 2000));
        Assert.True(watch.Lost(lastInputMs: 2600));
        watch.Seen(2600);
        Assert.False(watch.Lost(lastInputMs: 2600));

        Assert.False(watch.MouseDown(3000));
        watch.MouseUp(3100);
        Assert.False(watch.MouseDown(4000));
        Assert.True(watch.MouseDown(5000), "a mouse-down after a mouse-down: the mouse-up was missed");
        watch.Reinstalled(6000);
        Assert.False(watch.MouseDown(6100));
    }

    [Fact]
    public void Headless_options_are_read_with_the_arguments_last()
    {
        var o = HeadlessOptions.Parse(["--headless", "--app", @"C:\Apps\ErpDemo.exe", "--out", @"C:\out", "--name", "ERP Demo line items", "--args", "--ui", "v2"]);
        Assert.Equal((@"C:\Apps\ErpDemo.exe", @"C:\out", "ERP Demo line items"), (o.App, o.Out, o.Name));
        Assert.Equal(["--ui", "v2"], o.Args);
        Assert.Empty(HeadlessOptions.Parse(["--headless", "--app", "a.exe", "--out", "o", "--name", "n"]).Args);
        Assert.True(HeadlessOptions.IsHeadless(["--headless"]));
        Assert.False(HeadlessOptions.IsHeadless([]));
        Assert.Throws<ArgumentException>(() => HeadlessOptions.Parse(["--headless", "--app", "a.exe", "--name", "n"]));
        Assert.Throws<ArgumentException>(() => HeadlessOptions.Parse(["--headless", "--app", "a.exe", "--out", "o", "--name", "n", "--extra", "x"]));
    }

    [Fact]
    public void The_saved_files_are_named_after_the_recording()
    {
        Assert.Equal(("ERP Demo line items.rpa-recording.json", "ERP Demo line items.policy-change.json"),
            (SaveNames.Recording("ERP Demo line items"), SaveNames.PolicyChange("ERP Demo line items")));
        Assert.Equal("a_b_c_d.rpa-recording.json", SaveNames.Recording("a/b\\c:d"));
        Assert.Equal("_CON.rpa-recording.json", SaveNames.Recording("CON"));
        Assert.Equal("recording.rpa-recording.json", SaveNames.Recording(" .. "));
        Assert.Equal(new string('x', 100) + ".rpa-recording.json", SaveNames.Recording(new string('x', 200)));
    }
}
