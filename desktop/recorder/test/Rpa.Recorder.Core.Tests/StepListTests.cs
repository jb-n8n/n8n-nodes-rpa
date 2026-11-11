using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>The bar's step list: numbered rows with their marks and tooltips, the actions that fit the selected step,
/// the questions those actions ask, and the names they suggest.</summary>
public class StepListTests
{
    private static readonly ElementFacts User = El("Edit", "txtUser", "User name");
    private static readonly ElementFacts Password = El("Edit", "txtPassword", "Password", password: true);
    private static readonly ElementFacts Company = El("ComboBox", "cmbCompany", "Company code");
    private static readonly ElementFacts CompanyLabel = El("Text", "lblCompany", "Company code");
    private static readonly ElementFacts Search = El("Button", "btnSearch", "Search");

    /// <summary>Start, type the user, type the password, a click on a label, choose 2000, a click by row position, Search.</summary>
    private static Session Flow() => Record(
        new AppStarted(At(0), @"C:\Program Files\ERP Demo\ErpDemo.exe", [], Window),
        Typed(1, User), Left(2, User, "clerk"),
        Typed(3, Password), Left(4, Password, null),
        Click(5, CompanyLabel),
        Click(6, Company), Click(7, El("ListItem", "", "2000", "", false, false, Company)),
        Click(8, El("DataItem", "", "Vendor Row 1")),
        Click(9, Search));

    private static IReadOnlyList<(RecordedStep, bool)> NotLate(Session s) => s.Steps.Select(step => (step, false)).ToArray();

    [Fact]
    public void Rows_are_numbered_from_1_and_say_the_step_without_the_check_note_which_becomes_a_mark()
    {
        var rows = StepRows.Of(NotLate(Flow()));
        Assert.Equal([1, 2, 3, 4, 5, 6, 7], rows.Select(r => r.Number));
        Assert.Equal(
        [
            "Start ErpDemo.exe",
            "Type \"clerk\" into User name",
            "Type the secret password into Password",
            "Click Company code",
            "Choose \"2000\" in Company code",
            "Click Vendor Row 1",
            "Click Search",
        ], rows.Select(r => r.Text));
        Assert.Equal([StepMark.None, StepMark.None, StepMark.Secret, StepMark.Check, StepMark.None, StepMark.Check, StepMark.None], rows.Select(r => r.Mark));
    }

    [Fact]
    public void Each_mark_has_a_plain_word_and_a_tooltip_that_says_why()
    {
        Assert.Equal(["", "Variable", "Secret", "Check"], new[] { StepMark.None, StepMark.Variable, StepMark.Secret, StepMark.Check }.Select(StepRows.MarkText));
        var s = Flow();
        s.MarkVariable(4, "company_code");
        var rows = StepRows.Of(NotLate(s));
        Assert.Equal(StepMark.Variable, rows[4].Mark);
        Assert.Equal("On each run this value comes from the variable company_code, which n8n supplies.", rows[4].Tip);
        Assert.Equal("The typed value is not in the recording. On each run the secret variable password supplies it.", rows[2].Tip);
        Assert.Equal("A click on a label usually does nothing. Delete this step if it was a mistake.", rows[3].Tip);
        Assert.Equal("It finds its element by its row position, so on a later run it acts on whatever is in that row. Check it.", rows[5].Tip);
        Assert.Null(rows[0].Tip);
        Assert.Null(rows[6].Tip);
        // A screen reader says the number, the sentence and the mark.
        Assert.Equal("5. Choose the variable company_code in Company code (Variable)", StepRows.Spoken(rows[4]));
        Assert.Equal("7. Click Search", StepRows.Spoken(rows[6]));
    }

    [Fact]
    public void A_late_step_is_marked_to_check_and_a_late_secret_says_both_things()
    {
        var s = Flow();
        var late = s.Steps.Select((step, i) => (step, i is 2 or 6)).ToArray();
        var rows = StepRows.Of(late);
        Assert.Equal(StepMark.Check, rows[6].Mark);
        Assert.Equal("The app answered late, so this step was recorded as it was then. Check it, and delete it if it is wrong.", rows[6].Tip);
        Assert.Equal(StepMark.Check, rows[2].Mark);
        Assert.Equal("The app answered late, so this step was recorded as it was then. Check it, and delete it if it is wrong. " +
                     "The typed value is not in the recording. On each run the secret variable password supplies it.", rows[2].Tip);
    }

    [Fact]
    public void A_read_found_by_its_text_is_marked_to_check()
    {
        var s = Flow();
        s.AddRead(El("DataItem", "4237251161", "Acme Paper Co"), Window, "out_vendor");
        var row = StepRows.Of(NotLate(s))[^1];
        Assert.Equal(("Read DataItem as out_vendor", StepMark.Check), (row.Text, row.Mark));
        Assert.Equal("It finds its element by the text it shows now, so it may not find it once that text changes. Check it.", row.Tip);
    }

    [Fact]
    public void The_step_actions_are_enabled_only_for_a_selected_step_they_fit()
    {
        var steps = Flow().Steps;
        Assert.Equal(new StepActions(false, false, false, "Select a step to change it."), StepRows.ActionsFor(null, 0));
        Assert.Equal(new StepActions(true, true, true, "Step 2 is selected."), StepRows.ActionsFor(steps[1], 2));
        Assert.Equal(new StepActions(true, false, false, "Step 3 is already a secret."), StepRows.ActionsFor(steps[2], 3));
        Assert.Equal(new StepActions(true, false, false, "Step 7 has no value to make a variable or a secret."), StepRows.ActionsFor(steps[6], 7));
        // A chosen item can be a variable; only a typed value can be a secret.
        Assert.Equal(new StepActions(true, true, false, "Step 5 is selected."), StepRows.ActionsFor(steps[4], 5));
        Assert.Equal(new StepActions(true, false, false, "Step 1 has no value to make a variable or a secret."), StepRows.ActionsFor(steps[0], 1));

        // A file name typed into a Save dialog goes into the run's export folder: it stays as recorded.
        var save = new WindowFacts("app.exe", "Save As", "#32770");
        var fileName = El("Edit", "1001", "File name:", "Edit", false, false, El("ComboBox", "FileNameControlHost", "File name:"));
        var export = Record(Typed(1, fileName, save), Left(2, fileName, @"C:\out\report.csv", window: save)).Steps[0];
        Assert.Equal(new StepActions(true, false, false, "Step 4 saves a file into the run's export folder: its name stays as recorded."), StepRows.ActionsFor(export, 4));
    }

    [Fact]
    public void The_variable_question_names_the_step_and_its_value_and_uses_the_buttons_words()
    {
        var steps = Flow().Steps;
        var q = DialogText.Variable(5, steps[4]);
        Assert.Equal("Make step 5 a variable", q.Title);
        Assert.Equal("Step 5 chooses \"2000\" in Company code. On each run this value comes from the variable below (n8n supplies it).", q.Text);
        Assert.Equal(("Variable name", "company_code", "Make variable"), (q.NameLabel, q.Suggested, q.Action));
        Assert.Equal(BarText.MakeVariable, q.Action + "…");

        var typed = DialogText.Variable(2, steps[1]);
        Assert.Equal("Step 2 types \"clerk\" into User name. On each run this value comes from the variable below (n8n supplies it).", typed.Text);
        Assert.Equal("user_name", typed.Suggested);

        // A value that is a variable already: the question names the variable, and suggests its name.
        var s = Flow();
        s.MarkVariable(4, "in_CompanyCode");
        var again = DialogText.Variable(5, s.Steps[4]);
        Assert.Equal("Step 5 chooses the variable in_CompanyCode in Company code. On each run this value comes from the variable below (n8n supplies it).", again.Text);
        Assert.Equal("in_CompanyCode", again.Suggested);
    }

    [Fact]
    public void The_secret_question_says_the_typed_value_is_removed_now()
    {
        var q = DialogText.Secret(2, Flow().Steps[1]);
        Assert.Equal("Make step 2 a secret", q.Title);
        Assert.Equal("Step 2 types \"clerk\" into User name. The typed value is removed from the recording now. " +
                     "On each run it comes from the secret variable below, which n8n supplies from an RPA Secret Variables credential.", q.Text);
        Assert.Equal(("Secret variable name", "user_name", "Make secret"), (q.NameLabel, q.Suggested, q.Action));
        Assert.Equal(BarText.MakeSecret, q.Action + "…");
    }

    [Fact]
    public void The_read_question_names_the_element_by_what_the_person_sees()
    {
        var count = El("Text", "lblResultCount", "7 line items");
        var q = DialogText.Read(9, count);
        Assert.Equal("Read a value", q.Title);
        Assert.Equal("Step 9 reads the text \"7 line items\". On each run the bot reads it again and returns what it shows under the name below.", q.Text);
        Assert.Equal(("Output name", "out_result_count", "Add read step"), (q.NameLabel, q.Suggested, q.Action));

        // No visible text: the id, else the kind of element.
        Assert.Equal("Step 3 reads the box with the id txtTotal. On each run the bot reads it again and returns what it shows under the name below.",
            DialogText.Read(3, El("Edit", "txtTotal", "")).Text);
        Assert.Equal("Step 3 reads the element under the pointer. On each run the bot reads it again and returns what it shows under the name below.",
            DialogText.Read(3, El("Pane", "", "")).Text);
        Assert.Equal("Step 3 reads the cell \"Acme Paper Co\". On each run the bot reads it again and returns what it shows under the name below.",
            DialogText.Read(3, El("DataItem", "4237251161", "Acme Paper Co")).Text);
        // A long text is cut, and a line break does not reach the question.
        Assert.Equal($"Step 3 reads the text \"{new string('x', 59)}…\". On each run the bot reads it again and returns what it shows under the name below.",
            DialogText.Read(3, El("Text", "", new string('x', 80))).Text);
        Assert.Equal("Step 3 reads the text \"two lines\". On each run the bot reads it again and returns what it shows under the name below.",
            DialogText.Read(3, El("Text", "", "two\r\nlines")).Text);
    }

    [Fact]
    public void A_read_step_on_the_bar_says_what_the_person_pointed_at()
    {
        var s = Flow();
        s.AddRead(El("Text", "lblResultCount", "6 line items"), Window, "out_result_count");
        var read = s.Steps[^1];
        // The file keeps the id; the bar says the text the element showed when F9 was pressed.
        Assert.Equal("lblResultCount", read.Label);
        Assert.Equal("Read \"6 line items\" as out_result_count", StepText.Action(read, "6 line items"));
        Assert.Equal("Read lblResultCount as out_result_count", StepText.Action(read, null));
        Assert.Equal("Read lblResultCount as out_result_count", StepText.Action(read, "  "));
        Assert.Equal($"Read \"{new string('x', 39)}…\" as out_result_count", StepText.Action(read, new string('x', 60)));
        Assert.Equal("Read \"two lines\" as out_result_count", StepText.Action(read, "two\r\nlines"));
        // Only a read: any other step is its sentence.
        Assert.Equal("Click Search", StepText.Action(s.Steps[6], "ignored"));

        var rows = StepRows.Of(NotLate(s), step => step.Kind == StepKind.Read ? "6 line items" : null);
        Assert.Equal("Read \"6 line items\" as out_result_count", rows[^1].Text);
        Assert.Equal("Click Search", rows[6].Text);
    }

    [Fact]
    public void A_read_name_is_suggested_from_the_id_in_words_never_from_the_text_read()
    {
        Assert.Equal("out_result_count", StepText.SuggestedReadName(El("Text", "lblResultCount", "7 line items")));
        Assert.Equal("out_total", StepText.SuggestedReadName(El("Edit", "txtTotal", "120.00")));
        Assert.Equal("out_vendor_name", StepText.SuggestedReadName(El("Text", "VendorName", "Acme")));
        Assert.Equal("out_status", StepText.SuggestedReadName(El("Text", "status", "Open")));
        Assert.Equal("out_lbl", StepText.SuggestedReadName(El("Text", "lbl", "Open")));
        Assert.Equal("out_order_id2", StepText.SuggestedReadName(El("Text", "lblOrderID2", "4711")));
        // A generated id is not stable: the kind of element, never the text it shows.
        Assert.Equal("out_data_item", StepText.SuggestedReadName(El("DataItem", "4237251161", "Acme Paper Co")));
        Assert.Equal("out_text", StepText.SuggestedReadName(El("Text", "", "7 line items")));
        foreach (var e in new[] { El("Text", "lblResultCount", "x"), El("DataItem", "1", "x"), El("Text", new string('a', 90), "x") })
            Assert.True(SecretRules.IsVariableName(StepText.SuggestedReadName(e)));
    }

    [Fact]
    public void A_name_problem_is_said_under_the_name_box_and_the_rule_otherwise()
    {
        Assert.Null(DialogText.NameProblem("company_code", []));
        Assert.Equal("Type a name.", DialogText.NameProblem("  ", []));
        Assert.Equal("A name holds only letters, digits and _, starts with a letter or _, and has at most 64 characters.", DialogText.NameProblem("2nd value", []));
        Assert.Equal("A name holds only letters, digits and _, starts with a letter or _, and has at most 64 characters.", DialogText.NameProblem(new string('a', 65), []));
        Assert.Equal("Another read step already returns out_total: choose another name.", DialogText.NameProblem("out_total", ["out_total"]));
        Assert.Equal("Letters, digits and _, starting with a letter or _, at most 64 characters.", DialogText.NameRule);
    }

    [Fact]
    public void Steps_are_unsaved_until_saved_and_again_after_a_change()
    {
        var s = Flow();
        Assert.False(StepRows.Unsaved(null, []));
        Assert.True(StepRows.Unsaved(null, s.Steps));
        var saved = s.Steps;
        Assert.False(StepRows.Unsaved(saved, s.Steps));
        s.MarkVariable(4, "company_code");
        Assert.True(StepRows.Unsaved(saved, s.Steps));
        // Deleting every step leaves nothing to lose.
        while (s.Steps.Count > 0) s.Delete(0);
        Assert.False(StepRows.Unsaved(saved, s.Steps));
    }

    [Fact]
    public void The_list_scrolls_so_that_the_newest_step_is_in_view()
    {
        // Rows of these heights in a list this high: the first row shown is the one after which the rest fit.
        Assert.Equal(0, StepRows.TopIndexShowingLast([20, 20, 20], 100));
        Assert.Equal(2, StepRows.TopIndexShowingLast([20, 20, 20, 20, 20, 20, 20], 100));
        Assert.Equal(4, StepRows.TopIndexShowingLast([20, 20, 20, 20, 40, 60], 100));
        // The newest row alone is higher than the list: it is the first one shown.
        Assert.Equal(2, StepRows.TopIndexShowingLast([20, 20, 120], 100));
        Assert.Equal(0, StepRows.TopIndexShowingLast([], 100));
    }

    [Fact]
    public void The_list_follows_the_newest_step_when_it_changed_and_not_when_an_older_one_is_edited()
    {
        var s = Flow();
        var before = s.Steps;
        Assert.False(StepRows.NewestChanged(before, s.Steps));
        s.MarkVariable(4, "company_code");
        Assert.False(StepRows.NewestChanged(before, s.Steps));
        s.Add(Click(20, El("Button", "btnPost", "Post")));
        Assert.True(StepRows.NewestChanged(before, s.Steps));
        // A deleted step: the list stays where the person is.
        var withPost = s.Steps;
        s.Delete(1);
        Assert.False(StepRows.NewestChanged(withPost, s.Steps));
        // A click into a field becomes the fill when the field is left: the newest row changed, the count did not.
        var typing = Record(Click(1, User));
        var clicked = typing.Steps;
        typing.Add(Typed(2, User));
        typing.Add(Left(3, User, "clerk"));
        Assert.True(StepRows.NewestChanged(clicked, typing.Steps));
        Assert.False(StepRows.NewestChanged([], []));
    }
}
