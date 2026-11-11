using System.Text.RegularExpressions;
using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

public class SessionTests
{
    private static readonly ElementFacts Name = El("Edit", "txtName", "Name");
    private static readonly ElementFacts City = El("Edit", "txtCity", "City");
    private static readonly ElementFacts Company = El("ComboBox", "cmbCompany", "Company code");
    private static readonly ElementFacts Ok = El("Button", "btnOk", "OK");
    private static readonly ElementFacts Grid = El("DataGrid", "gridResults", "Results");

    private static ElementFacts Item(string text) => El("ListItem", "", text, "", false, false, El("List", "1000", "Company code"), Company);

    /// <summary>The steps as the bar lists them: kind and label.</summary>
    private static string Listed(Session s) => string.Join(", ", s.Steps.Select(x => $"{x.Kind} {x.Label}"));

    private static string Json(Session s) => s.ToFile("Test").ToJson();

    [Fact]
    public void A_fields_text_comes_from_FieldLeft_Value_never_from_keys()
    {
        var s = Record(Click(1, Name), Typed(2, Name), Typed(3, Name), Typed(4, Name), Left(5, Name, "Ada"), Click(5, Ok));
        Assert.Equal("Fill Name, Click OK", Listed(s));
        Assert.Equal("Ada", s.Steps[0].Value);

        // A value that could not be read gives no fill: the keys never stand in for it.
        s = Record(Click(1, Name), Typed(2, Name), Left(3, Name, null), Click(3, Ok));
        Assert.Equal("Click Name, Click OK", Listed(s));
    }

    [Fact]
    public void A_secret_fields_fill_is_a_variable_and_its_value_is_never_stored()
    {
        var typed = NewSecret();
        var password = El("Edit", "txtPassword", "Password", password: true);
        // The Windows layer never reads a secret field; here it reports a value anyway, and it is still not kept.
        var s = Record(Click(1, password), Typed(2, password), Typed(3, password), Left(4, password, typed), Key(4, password, "Enter"));

        Assert.Equal("Fill Password, Key Password", Listed(s));
        Assert.Equal("{{var.password}}", s.Steps[0].Value);
        Assert.True(s.Steps[0].Secret);
        var file = s.ToFile("Sign in");
        Assert.Equal(["password"], file.SecretVariables);
        Assert.False(file.ToJson().Contains(typed), "the typed value is in the recording file");
        Assert.False(StringsIn(s).Any(x => x.Contains(typed)), "the typed value is kept in the session");
    }

    [Fact]
    public void A_field_with_a_credential_like_name_or_id_is_secret()
    {
        var typed = NewSecret();
        var fields = new[]
        {
            (El("Edit", "txtCode", "PIN"), "pin"),
            (El("Edit", "txtApiKey", ""), "txtapikey"),
            (El("Edit", "txtS", "Senha"), "senha"),
            (El("Edit", "user_pass", "4 digits"), "field_4_digits"),
        };
        foreach (var (field, variable) in fields)
        {
            Assert.True(SecretRules.IsSecret(field));
            var s = Record(Typed(1, field), Left(2, field, typed));
            Assert.Equal($"{{{{var.{variable}}}}}", s.Steps[0].Value);
            Assert.True(s.Steps[0].Secret);
            Assert.False(Json(s).Contains(typed), "the typed value is in the recording file");
        }
        Assert.False(SecretRules.IsSecret(El("Edit", "txtPassenger", "Passenger name")));
        Assert.False(SecretRules.IsSecret(El("Edit", "txtCompass", "Compass heading")));
    }

    [Fact]
    public void The_importers_password_words_are_the_recorders()
    {
        // The importer refuses a typed value in a field its CREDENTIAL_FIELD names a password field, so the recorder
        // takes every such field for secret: its words are read here from the engine's own file.
        var ts = RepoFile("packages", "engine", "src", "secrets", "credential-field.ts");
        var list = Regex.Match(ts, @"const PASSWORD_WORDS = \[(.*?)\n\];", RegexOptions.Singleline).Groups[1].Value;
        var withoutComments = Regex.Replace(list, @"//[^\n]*", "");
        var words = Regex.Matches(withoutComments, @"'([^']*)'|""([^""]*)""").Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
        Assert.Equal(words, SecretRules.PasswordWords);
        // The whole pattern: the words, PASSWORD_FIELD's tail (\b spelled out as a boundary of ASCII word characters, as
        // JavaScript reads it) and CREDENTIAL_FIELD's tail.
        var passwordTail = Regex.Match(ts, @"export const PASSWORD_FIELD = new RegExp\(`\$\{PASSWORD_WORDS\.join\('\|'\)\}(.*?)`, 'i'\);").Groups[1].Value;
        var credentialTail = Regex.Match(ts, @"export const CREDENTIAL_FIELD = new RegExp\(`\$\{PASSWORD_FIELD\.source\}(.*?)`, 'i'\);").Groups[1].Value;
        Assert.NotEqual("", passwordTail);
        Assert.NotEqual("", credentialTail);
        var asDotNet = Regex.Replace(passwordTail.Replace(@"\\", @"\"), @"\\b(\w+)\\b", "(?<![A-Za-z0-9_])$1(?![A-Za-z0-9_])");
        Assert.Equal(string.Join('|', words) + asDotNet + credentialTail, SecretRules.CredentialFieldPattern);
    }

    [Fact]
    public void A_ListItem_under_a_ComboBox_becomes_a_select_and_the_opening_click_is_folded()
    {
        var s = Record(Click(1, Company), Click(2, Item("2000")));
        Assert.Equal("Select Company code", Listed(s));
        var select = s.Steps[0];
        Assert.Equal("2000", select.Option);
        Assert.Equal(At(2), select.At);
        Assert.Equal([new RecordedCondition("ComboBox", "cmbCompany", "Company code")], select.Target!.Path);

        // Opened by the ComboBox's button, it is the same.
        var button = El("Button", "DropDown", "Open", "", false, false, Company);
        Assert.Equal("Select Company code", Listed(Record(Click(1, button), Click(2, Item("2000")))));

        // A list opened and closed again is a click.
        Assert.Equal("Click Company code, Click OK", Listed(Record(Click(1, Company), Click(2, Ok))));
    }

    [Fact]
    public void A_drop_downs_keyboard_selection_comes_from_FieldLeft_Selection()
    {
        var s = Record(Click(1, Company), Typed(2, Company), Typed(3, Company), Left(4, Company, "1000", "2000"), Key(4, Company, "Enter"));
        Assert.Equal("Select Company code, Key Company code", Listed(s));
        Assert.Equal("2000", s.Steps[0].Option);
        Assert.Equal(At(1), s.Steps[0].At);
    }

    [Fact]
    public void An_editable_ComboBox_is_decided_by_HasEditChild()
    {
        var editable = El("ComboBox", "cmbCity", "City", editChild: true);
        var fill = Record(Typed(1, editable), Left(2, editable, "Berlin", "Bonn")).Steps.Single();
        Assert.Equal((StepKind.Fill, "Berlin"), (fill.Kind, fill.Value));
        var select = Record(Typed(1, Company), Left(2, Company, "Berlin", "Bonn")).Steps.Single();
        Assert.Equal((StepKind.Select, "Bonn"), (select.Kind, select.Option));
    }

    [Fact]
    public void Tab_before_a_fill_is_folded()
    {
        var s = Record(Click(1, Name), Typed(2, Name), Left(3, Name, "Ada"), Key(3, Name, "Tab"), Typed(4, City), Left(5, City, "Paris"), Key(5, City, "Enter"));
        Assert.Equal("Fill Name, Fill City, Key City", Listed(s));
        s = Record(Typed(1, City), Left(2, City, "Paris"), Key(2, City, "Shift+Tab"), Key(3, Name, "Shift+Tab"), Typed(4, Name), Left(5, Name, "Ada"));
        Assert.Equal("Fill City, Fill Name", Listed(s));

        // A Tab that only moves on stays.
        s = Record(Typed(1, Name), Left(2, Name, "Ada"), Key(2, Name, "Tab"), Click(3, Ok));
        Assert.Equal("Fill Name, Key Name, Click OK", Listed(s));
    }

    [Fact]
    public void Tab_before_a_select_is_folded()
    {
        var s = Record(Typed(1, Name), Left(2, Name, "Ada"), Key(2, Name, "Tab"), Typed(3, Company), Left(4, Company, null, "2000"));
        Assert.Equal("Fill Name, Select Company code", Listed(s));
        s = Record(Typed(1, Name), Left(2, Name, "Ada"), Key(2, Name, "Tab"), Click(3, Company), Click(4, Item("2000")));
        Assert.Equal("Fill Name, Select Company code", Listed(s));
    }

    [Fact]
    public void A_click_into_a_field_that_is_then_typed_into_folds_into_the_fill()
    {
        var s = Record(Click(1, Name), Typed(2, Name), Click(3, Name), Typed(4, Name), Left(5, Name, "Ada"));
        var fill = Assert.Single(s.Steps);
        Assert.Equal((StepKind.Fill, "Ada", At(1)), (fill.Kind, fill.Value, fill.At));
        Assert.Equal([new RecordedCondition("Edit", "txtName", "Name")], fill.Target!.Path);
    }

    [Fact]
    public void A_click_into_a_field_that_is_never_typed_into_stays_a_click()
    {
        var s = Record(Click(1, Name), Left(2, Name, "Ada"), Click(2, Ok));
        Assert.Equal("Click Name, Click OK", Listed(s));
    }

    [Fact]
    public void A_key_event_acts_on_the_focused_element_with_its_chord()
    {
        var s = Record(Typed(1, Name), Left(2, Name, "Ada"), Key(2, Name, "Enter"), Key(3, Grid, "F5"), Key(4, Grid, "Ctrl+F"));
        Assert.Equal("Fill Name, Key Name, Key Results, Key Results", Listed(s));
        Assert.Equal(["Enter", "F5", "Ctrl+F"], s.Steps.Skip(1).Select(x => x.Chord));
        Assert.Equal([new RecordedCondition("DataGrid", "gridResults", "Results")], s.Steps[2].Target!.Path);
        // Typing into something that takes no text is not recorded.
        Assert.Equal("Click OK", Listed(Record(Click(1, Ok), Typed(2, Ok), Typed(3, Grid))));
    }

    [Fact]
    public void A_click_on_an_unchecked_check_box_is_a_check_step_with_checked_true()
    {
        var box = El("CheckBox", "chkMatchCase", "Match case") with { IsChecked = false };
        var check = Record(Click(1, box)).Steps.Single();
        Assert.Equal((StepKind.Check, true, "Match case"), (check.Kind, check.Checked, check.Label));
        Assert.Equal([new RecordedCondition("CheckBox", "chkMatchCase", "Match case")], check.Target!.Path);
    }

    [Fact]
    public void A_click_on_a_checked_check_box_is_a_check_step_with_checked_false()
    {
        var check = Record(Click(1, El("CheckBox", "chkMatchCase", "Match case") with { IsChecked = true })).Steps.Single();
        Assert.Equal((StepKind.Check, false), (check.Kind, check.Checked));
        // With no toggle state to read it stays a click; a Space on a focused check box stays a key.
        Assert.Equal(StepKind.Click, Record(Click(1, El("CheckBox", "chkMatchCase", "Match case"))).Steps.Single().Kind);
        Assert.Equal(StepKind.Key, Record(Key(1, El("CheckBox", "chkMatchCase", "Match case") with { IsChecked = false }, "Space")).Steps.Single().Kind);
    }

    [Fact]
    public void A_radio_button_is_a_click()
    {
        var radio = El("RadioButton", "optDaily", "Daily") with { IsChecked = false };
        Assert.Equal(StepKind.Click, Record(Click(1, radio)).Steps.Single().Kind);
    }

    [Fact]
    public void Deleting_a_fill_deletes_the_click_folded_into_it()
    {
        var s = Record(Click(1, Name), Typed(2, Name), Left(3, Name, "Ada"), Click(3, Ok));
        s.Delete(0);
        Assert.Equal("Click OK", Listed(s));
        Assert.DoesNotContain("txtName", Json(s));

        s = Record(Click(1, Company), Click(2, Item("2000")), Click(3, Ok));
        s.Delete(0);
        Assert.Equal("Click OK", Listed(s));
        Assert.DoesNotContain("cmbCompany", Json(s));
    }

    [Fact]
    public void Marking_a_step_secret_removes_its_value_from_the_file()
    {
        // A password box the recorder does not recognise: no password flag, no telling name.
        var typed = NewSecret();
        var code = El("Edit", "codeBox", "Code");
        var s = Record(Click(1, code), Typed(2, code), Left(3, code, typed), Click(3, Ok));
        Assert.Equal(typed, s.Steps[0].Value);

        s.MarkSecret(0, "code");
        Assert.Equal(("{{var.code}}", true), (s.Steps[0].Value, s.Steps[0].Secret));
        var file = s.ToFile("Test");
        Assert.Equal(["code"], file.SecretVariables);
        Assert.False(file.ToJson().Contains(typed), "the typed value is in the recording file");
        Assert.False(StringsIn(s).Any(x => x.Contains(typed)), "the typed value is kept in the session");
        Assert.Throws<InvalidOperationException>(() => s.MarkSecret(1, "ok"));
    }

    [Fact]
    public void Marking_a_step_as_a_variable_replaces_its_value()
    {
        var s = Record(Typed(1, Name), Left(2, Name, "Ada"), Click(3, Company), Click(4, Item("2000")), Click(5, Ok));
        s.MarkVariable(0, "username");
        s.MarkVariable(1, "in_CompanyCode");
        Assert.Equal(("{{var.username}}", false), (s.Steps[0].Value, s.Steps[0].Secret));
        Assert.Equal("{{var.in_CompanyCode}}", s.Steps[1].Option);
        Assert.Empty(s.ToFile("Test").SecretVariables);
        Assert.Throws<InvalidOperationException>(() => s.MarkVariable(2, "ok"));
        foreach (var bad in new[] { "", "1st", "user name", "a}}", "x.y" })
            Assert.Throws<ArgumentException>(() => s.MarkVariable(0, bad));

        // A secret fill keeps its secret under the new name.
        var password = El("Edit", "txtPassword", "Password", password: true);
        s = Record(Typed(1, password), Left(2, password, null));
        s.MarkVariable(0, "erp_password");
        Assert.Equal(("{{var.erp_password}}", true), (s.Steps[0].Value, s.Steps[0].Secret));
        Assert.Equal(["erp_password"], s.ToFile("Test").SecretVariables);
    }

    [Fact]
    public void A_read_takes_the_elements_text_as_a_named_output()
    {
        var count = El("Text", "lblResultCount", "6 line items");
        var s = Record(Click(1, Ok));
        s.AddRead(count, Window, "out_ResultCount");
        var read = s.Steps[1];
        // The label's text is the value read, not what finds it: the step names it by its id.
        Assert.Equal((StepKind.Read, "out_ResultCount", "lblResultCount", false), (read.Kind, read.As, read.Label, read.FoundByText));
        Assert.Equal([new RecordedCondition("Text", "lblResultCount", null)], read.Target!.Path);
        Assert.Throws<ArgumentException>(() => s.AddRead(count, Window, "out_ResultCount"));
        Assert.Throws<ArgumentException>(() => s.AddRead(count, Window, "out result"));
    }

    [Fact]
    public void A_scope_comes_where_the_window_changes_and_goes_with_its_steps()
    {
        WindowFacts a = new("app.exe", "Orders", WinFormsClass), b = new("app.exe", "Confirm", WinFormsClass);
        var s = Record(Click(1, Ok, window: a), Click(2, El("Button", "btnYes", "Yes"), window: b), Click(3, Ok, window: a));
        string Events() => string.Join(", ", s.ToFile("Test").Events.Select(e => $"{e.Kind} {e.Label}"));
        Assert.Equal("Scope Orders, Click OK, Scope Confirm, Click Yes, Scope Orders, Click OK", Events());
        s.Delete(1);
        Assert.Equal("Scope Orders, Click OK, Click OK", Events());
    }

    [Fact]
    public void The_ERP_Demo_observation_list_gives_the_16_tidy_events_of_the_spike()
    {
        var s = Record(ErpDemoObservations.List());
        Assert.Equal(13, s.Steps.Count);
        Assert.Equal(
        [
            "Launch ErpDemo.exe", "Fill User name", "Fill Password", "Key Password", "Scope ERP Demo - Line items",
            "Select Company code", "Fill Date from", "Fill Date to", "Click Search", "Click Vendor Row 1", "Click File",
            "Scope erpdemo.exe", "Click Export...", "Scope Export line items", "Fill File name:", "Click Save",
        ], s.ToFile("ERP Demo line items").Events.Select(e => $"{e.Kind} {e.Label}"));
    }
}
