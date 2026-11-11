using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>The page after Finish that asks once which recorded values change from run to run: which steps it offers,
/// the names it suggests, how it checks them, and what Continue makes of the ticks.</summary>
public class ValuesPageTests
{
    private static readonly ElementFacts User = El("Edit", "txtUser", "User name");
    private static readonly ElementFacts Password = El("Edit", "txtPassword", "Password", password: true);
    private static readonly ElementFacts Company = El("ComboBox", "cmbCompany", "Company code");
    private static readonly ElementFacts DateFrom = El("Edit", "dtFrom", "Date");
    private static readonly ElementFacts DateTo = El("Edit", "dtTo", "Date");
    private static readonly ElementFacts Notes = El("Edit", "txtNotes", "Notes");
    private static readonly WindowFacts SaveAs = new("app.exe", "Save As", "#32770");
    private static readonly ElementFacts FileName = El("Edit", "1001", "File name:", "Edit", false, false, El("ComboBox", "FileNameControlHost", "File name:"));

    /// <summary>
    /// 0 start, 1 type the user, 2 type the password (secret), 3 Enter, 4 choose 2000, 5 and 6 two fields both labelled
    /// Date, 7 Search, 8 a file name in a Save dialog, 9 type into Notes, then a read.
    /// </summary>
    private static Session Flow()
    {
        var s = Record(
            new AppStarted(At(0), @"C:\Program Files\ERP Demo\ErpDemo.exe", [], Window),
            Typed(1, User), Left(2, User, "clerk"),
            Typed(3, Password), Left(4, Password, null),
            Key(5, Password, "Enter"),
            Click(6, Company), Click(7, El("ListItem", "", "2000", "", false, false, Company)),
            Typed(8, DateFrom), Left(9, DateFrom, "2026-01-20"),
            Typed(10, DateTo), Left(11, DateTo, "2026-11-30"),
            Click(12, El("Button", "btnSearch", "Search")),
            Typed(13, FileName, SaveAs), Left(14, FileName, @"C:\out\line-items.csv", window: SaveAs),
            Typed(15, Notes, Window), Left(16, Notes, "monthly"));
        s.AddRead(El("Text", "lblResultCount", "6 line items"), Window, "out_result_count");
        return s;
    }

    [Fact]
    public void Every_typed_value_and_chosen_item_is_offered_and_nothing_else()
    {
        var steps = Flow().Steps;
        var rows = ValuesPage.Rows(steps);
        // Not the start, the key, the click, the file name of the Save dialog (its name stays as recorded) or the read.
        Assert.Equal([1, 2, 4, 5, 6, 9], rows.Select(r => r.Index));
        Assert.Equal([2, 3, 5, 6, 7, 10], rows.Select(r => r.Number));
        Assert.Equal([false, true, true, false, true, true, true, false, false, true, false], steps.Select(ValuesPage.Offers));
    }

    [Fact]
    public void A_recorded_value_starts_unticked_and_reads_as_on_the_list_with_a_suggested_name()
    {
        var rows = ValuesPage.Rows(Flow().Steps);
        var user = rows[0];
        Assert.Equal((ValueKind.Recorded, false, "user_name"), (user.Kind, user.Ticked, user.Name));
        // The same sentence and the same number as the list.
        Assert.Equal("Type \"clerk\" into User name", user.Text);
        Assert.Equal(StepRows.Of(Flow().Steps.Select(s => (s, false)).ToArray())[1].Text, user.Text);
        Assert.Equal("Choose \"2000\" in Company code", rows[2].Text);
        Assert.Equal("company_code", rows[2].Name);
        Assert.True(user.CanUntick);
        // The name box is for a ticked value.
        Assert.False(user.NameEditable);
        Assert.True(user.WithTick(true).NameEditable);
    }

    [Fact]
    public void A_secret_shows_as_a_secret_by_its_variable_name_only_and_stays_one()
    {
        var typed = NewSecret();
        var s = Record(Typed(1, Notes), Left(2, Notes, typed), Typed(3, Password), Left(4, Password, null));
        // A value the recorder took for plain text, made secret on the bar while recording.
        s.MarkSecret(0, "notes_pin");
        var rows = ValuesPage.Rows(s.Steps);
        Assert.Equal([ValueKind.Secret, ValueKind.Secret], rows.Select(r => r.Kind));
        Assert.Equal(("Type the secret notes_pin into Notes", true, "notes_pin"), (rows[0].Text, rows[0].Ticked, rows[0].Name));
        Assert.Equal("Type the secret password into Password", rows[1].Text);
        Assert.Equal("A secret: the typed value is not in the recording. On each run n8n supplies password from an RPA Secret Variables credential.",
            ValuesPage.SecretNote(rows[1]));
        Assert.DoesNotContain(StringsIn(rows), text => text.Contains(typed, StringComparison.Ordinal));

        // It cannot be unticked into plain text, and its name is not changed here.
        Assert.False(rows[0].CanUntick);
        Assert.False(rows[0].NameEditable);
        Assert.Same(rows[0], rows[0].WithTick(false));
        Assert.Same(rows[0], rows[0].WithName("plain"));
        Assert.Empty(ValuesPage.Changes(rows));
    }

    [Fact]
    public void A_value_that_is_a_variable_already_is_ticked_and_can_be_renamed()
    {
        var s = Flow();
        s.MarkVariable(4, "in_CompanyCode");
        var row = ValuesPage.Rows(s.Steps).Single(r => r.Index == 4);
        Assert.Equal((ValueKind.Variable, true, "in_CompanyCode"), (row.Kind, row.Ticked, row.Name));
        Assert.Equal("Choose the variable in_CompanyCode in Company code", row.Text);
        // Taking it back to the recorded value is not something the recorder does: it stays ticked.
        Assert.False(row.CanUntick);
        Assert.Same(row, row.WithTick(false));
        Assert.True(row.NameEditable);
        Assert.Empty(ValuesPage.Changes([row]));
        Assert.Equal([(4, "company")], ValuesPage.Changes([row.WithName(" company ")]));
    }

    [Fact]
    public void Two_fields_that_suggest_one_name_get_names_of_their_own()
    {
        var rows = ValuesPage.Rows(Flow().Steps);
        // Both fields are labelled Date.
        Assert.Equal(["user_name", "password", "company_code", "date", "date_2", "notes"], rows.Select(r => r.Name));

        // A name a variable or a secret already has is not suggested again.
        var s = Flow();
        s.MarkVariable(1, "date");
        s.MarkVariable(9, "company_code");
        Assert.Equal(["date", "password", "company_code_2", "date_2", "date_3", "company_code"], ValuesPage.Rows(s.Steps).Select(r => r.Name));
        var otherNotes = El("Edit", "txtNotes2", "Notes");
        var secret = Record(Typed(1, Notes), Left(2, Notes, "a"), Typed(3, otherNotes), Left(4, otherNotes, "b"));
        secret.MarkSecret(0, "notes");
        Assert.Equal("notes_2", ValuesPage.Rows(secret.Steps)[1].Name);
        Assert.All(ValuesPage.Rows(Flow().Steps), r => Assert.True(SecretRules.IsVariableName(r.Name)));
    }

    [Fact]
    public void A_ticked_name_is_checked_as_the_variable_question_checks_it()
    {
        var rows = ValuesPage.Rows(Flow().Steps).ToList();
        Assert.Null(ValuesPage.Problem(rows));
        // An unticked value's name does not matter.
        rows[0] = rows[0].WithName("2nd user");
        Assert.Null(ValuesPage.Problem(rows));
        rows[0] = rows[0].WithTick(true);
        Assert.Equal("Step 2: A name holds only letters, digits and _, starts with a letter or _, and has at most 64 characters.", ValuesPage.Problem(rows));
        rows[0] = rows[0].WithName("  ");
        Assert.Equal("Step 2: Type a name.", ValuesPage.Problem(rows));
        rows[0] = rows[0].WithName("user");
        // The same name for two values is one variable, as on the bar.
        rows[2] = rows[2].WithTick(true).WithName("user");
        Assert.Null(ValuesPage.Problem(rows));
    }

    [Fact]
    public void Continue_makes_each_ticked_value_a_variable_that_starts_with_its_recorded_value()
    {
        var s = Flow();
        var rows = ValuesPage.Rows(s.Steps).ToList();
        rows[0] = rows[0].WithTick(true);
        rows[2] = rows[2].WithTick(true).WithName("in_company");
        rows[3] = rows[3].WithTick(true).WithName("date_from");
        // Ticked, then unticked again: stays as recorded.
        rows[5] = rows[5].WithTick(true).WithTick(false);
        Assert.Equal([(1, "user_name"), (4, "in_company"), (5, "date_from")], ValuesPage.Changes(rows));

        ValuesPage.Apply(s, rows);
        var file = s.ToFile("Line items");
        Assert.Equal(new Dictionary<string, string> { ["user_name"] = "clerk", ["in_company"] = "2000", ["date_from"] = "2026-01-20" }, file.Variables);
        Assert.Equal(["password"], file.SecretVariables);
        Assert.Equal(["{{var.user_name}}", "{{var.password}}", "{{var.date_from}}", "2026-11-30", "monthly"],
            s.Steps.Where(x => x.Kind == StepKind.Fill && x.ExportFile is null).Select(x => x.Value));
        Assert.Equal("{{var.in_company}}", s.Steps[4].Option);
        // The file name of the Save dialog is untouched.
        Assert.Equal("line-items.csv", s.Steps[8].ExportFile);
    }

    [Fact]
    public void Continue_with_nothing_ticked_changes_nothing()
    {
        var s = Flow();
        var before = s.ToFile("Line items").ToJson();
        ValuesPage.Apply(s, ValuesPage.Rows(s.Steps));
        Assert.Equal(before, s.ToFile("Line items").ToJson());
    }

    [Fact]
    public void A_renamed_variable_keeps_the_value_it_started_with()
    {
        var s = Flow();
        s.MarkVariable(1, "user");
        var rows = ValuesPage.Rows(s.Steps).Select(r => r.Index == 1 ? r.WithName("login") : r).ToArray();
        ValuesPage.Apply(s, rows);
        Assert.Equal(new Dictionary<string, string> { ["login"] = "clerk" }, s.ToFile("Line items").Variables);
    }

    [Fact]
    public void Choices_made_before_Back_are_there_when_the_page_shows_again()
    {
        var s = Flow();
        var rows = ValuesPage.Rows(s.Steps).ToList();
        rows[0] = rows[0].WithTick(true).WithName("login");
        rows[3] = rows[3].WithTick(true);
        // Back, then the person deletes the second Date step and finishes again.
        s.Delete(6);
        var again = ValuesPage.Rows(s.Steps, rows);
        Assert.Equal([1, 2, 4, 5, 8], again.Select(r => r.Index));
        Assert.Equal([true, true, false, true, false], again.Select(r => r.Ticked));
        Assert.Equal(["login", "password", "company_code", "date", "notes"], again.Select(r => r.Name));
        // A step recorded after Back gets its own suggestion.
        s.Add(Typed(30, DateTo));
        s.Add(Left(31, DateTo, "2026-12-31"));
        var third = ValuesPage.Rows(s.Steps, again);
        Assert.Equal(("date_2", false), (third[^1].Name, third[^1].Ticked));
    }

    [Fact]
    public void The_page_shows_after_Finish_only_when_there_is_a_value_to_offer()
    {
        Assert.Equal(BarStage.Values, BarText.AfterFinish(Flow().Steps));
        Assert.Equal(BarStage.Finished, BarText.AfterFinish(Record(Click(1, El("Button", "btnSearch", "Search"))).Steps));
        Assert.Equal(BarStage.Finished, BarText.AfterFinish([]));
    }

    [Fact]
    public void The_page_asks_one_question_and_says_what_a_tick_does()
    {
        Assert.Equal("Which of these change from run to run?", BarText.Guidance(BarStage.Values));
        Assert.Equal("Tick each value that changes from run to run. n8n can then set it on each run, and it starts as recorded here.", ValuesPage.Intro);
        Assert.Equal(("Continue", "Back"), (ValuesPage.Continue, ValuesPage.Back));
        Assert.Equal("Variable name", ValuesPage.NameLabel);
    }

    [Fact]
    public void A_tick_that_cannot_be_taken_off_says_why()
    {
        // A typed value that holds {{ is the field's variable from the start: a step cannot type {{ as text.
        var s = Record(Typed(1, User), Left(2, User, "{{x}}"), Typed(3, Password), Left(4, Password, null), Typed(5, Notes), Left(6, Notes, "monthly"));
        var rows = ValuesPage.Rows(s.Steps);
        Assert.Equal((ValueKind.Variable, "user_name"), (rows[0].Kind, rows[0].Name));
        Assert.Equal("Its recorded value held {{, which a step cannot type as text, so it is a variable. Its name can change below.", ValuesPage.Tip(rows[0]));
        Assert.Equal("A secret stays a secret: its typed value is not in the recording.", ValuesPage.Tip(rows[1]));
        Assert.Null(ValuesPage.Tip(rows[2]));
    }
}
