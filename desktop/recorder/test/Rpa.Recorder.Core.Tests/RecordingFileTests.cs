using System.Text.Json;
using System.Text.RegularExpressions;
using Rpa.Runner.Core.Policy;
using static Rpa.Recorder.Core.Tests.Fakes;
using RunnerPolicyChange = Rpa.Runner.Core.Policy.PolicyChange;

namespace Rpa.Recorder.Core.Tests;

public class RecordingFileTests
{
    private static readonly ElementFacts Name = El("Edit", "txtName", "Name");
    private static readonly ElementFacts Ok = El("Button", "btnOk", "OK");
    private static readonly string Sha = Convert.ToHexString(new byte[32]).Replace('0', 'a');

    /// <summary>A <c>{{$...}}</c> template as the importer finds it (RESERVED in recording.ts).</summary>
    private static readonly Regex Reserved = new(@"\{\{[\s{]*(\$[^}]*?)\s*\}\}");

    [Fact]
    public void ToFile_output_is_accepted_by_the_engines_fixture_test()
    {
        // The engine imports recording-erp/erp.rpa-recording.json as the 17 steps of the reference flow; the recorder
        // writes exactly that file for the flow's observations.
        var golden = RepoFile("packages", "engine", "test", "fixtures", "import", "recording-erp", "erp.rpa-recording.json");
        var file = Record(ErpDemoObservations.List()).ToFile("ERP Demo line items");
        Assert.Equal(golden.ReplaceLineEndings("\n").TrimEnd(), file.ToJson().ReplaceLineEndings("\n").TrimEnd());
    }

    [Fact]
    public void The_ERP_Demo_file_never_holds_the_password_the_windows_layer_reported()
    {
        var typed = NewSecret();
        var s = Record(ErpDemoObservations.List(typed));
        Assert.False(s.ToFile("ERP Demo line items").ToJson().Contains(typed), "the typed value is in the recording file");
        Assert.False(StringsIn(s).Any(x => x.Contains(typed)), "the typed value is kept in the session");
    }

    [Fact]
    public void A_fill_into_a_Save_dialogs_file_name_types_the_file_into_the_export_folder()
    {
        WindowFacts dialog = new("app.exe", "Save As", "#32770"), main = new("app.exe", "Orders", "AppMain");
        // The file-name box of a common file dialog: control 1001 inside the FileNameControlHost combo box.
        var fileName = El("Edit", "1001", "File name:", "Edit", false, false, El("ComboBox", "FileNameControlHost", "File name:"));
        var s = Record(Click(1, fileName, window: dialog), Typed(2, fileName, dialog), Left(3, fileName, "C:/Users/clerk/report.csv", window: dialog));
        Assert.Equal(("{{$exportDir}}\\report.csv", "report.csv"), (s.Steps[0].Value, s.Steps[0].ExportFile));

        // The same field in another window, or a typed name that is no file name, stays a plain fill.
        s = Record(Typed(1, fileName, main), Left(2, fileName, "report.csv", window: main));
        Assert.Equal(("report.csv", null), (s.Steps[0].Value, s.Steps[0].ExportFile));
        s = Record(Typed(1, fileName, dialog), Left(2, fileName, @"C:\out\", window: dialog));
        Assert.Equal((@"C:\out\", null), (s.Steps[0].Value, s.Steps[0].ExportFile));
    }

    [Fact]
    public void Control_1001_of_a_dialog_that_is_not_a_file_dialog_stays_a_plain_fill()
    {
        // A Win32 app's own dialog is also #32770, and 1001 is an ordinary control id there.
        WindowFacts dialog = new("app.exe", "Customer", "#32770");
        var company = El("Edit", "1001", "Company", "Edit", false, false, El("Pane", "", ""), El("Window", "", "Customer", "#32770"));
        var s = Record(Typed(1, company, dialog), Left(2, company, "ACME Corp", window: dialog));
        Assert.Equal(("ACME Corp", null), (s.Steps[0].Value, s.Steps[0].ExportFile));
    }

    [Fact]
    public void A_recording_file_never_holds_a_template_the_importer_refuses()
    {
        WindowFacts odd = new("app.exe", "{{$exportDir}}", WinFormsClass);
        var button = El("Button", "", "{{ $env.HOME }} now");
        var s = Record(Typed(1, Name, odd), Left(2, Name, "{{$env.HOME}}", window: odd), Click(3, button, window: odd),
            Typed(4, Name, odd), Left(5, Name, "{{var.other}}", window: odd));
        Assert.Equal("{{var.name}}", s.Steps[0].Value);
        Assert.Equal("{{var.name}}", s.Steps[2].Value);
        var json = s.ToFile("Test").ToJson();
        Assert.False(Reserved.IsMatch(json), json);
        Assert.Contains("\"label\": \"{ { $env.HOME }} now\"", json);
    }

    [Fact]
    public void ToFile_refuses_a_name_the_importer_would_refuse_and_an_empty_recording()
    {
        var s = Record(Click(1, Ok));
        foreach (var bad in new[] { "", "two\nlines", new string('x', 201), "{{$exportDir}}" })
            Assert.Throws<ArgumentException>(() => s.ToFile(bad));
        Assert.Equal(new string('x', 200), s.ToFile(new string('x', 200)).Name);
        Assert.Throws<InvalidOperationException>(() => new Session().ToFile("Test"));
    }

    [Fact]
    public void A_recording_of_more_than_400_events_is_refused_when_saved()
    {
        // Each click on one window is an event, after the window's scope event.
        var clicks = Enumerable.Range(1, RecordingFile.MaxEvents).Select(i => (Observation)Click(i, El("Button", $"btn{i}", $"Button {i}"))).ToArray();
        Assert.Equal(RecordingFile.MaxEvents, Record(clicks[..^1]).ToFile("Test").Events.Count);
        var e = Assert.Throws<InvalidOperationException>(() => Record(clicks).ToFile("Test"));
        Assert.StartsWith("a recording holds at most 400 events; this one has 401", e.Message);
    }

    [Fact]
    public void The_recording_limits_are_the_importers_and_the_step_parsers()
    {
        // The engine's importers (recording.ts and the files beside it, which it may share constants with), its step
        // parser and the desktop vocabulary both of them use, read in place.
        var engine = string.Concat(Directory.GetFiles(RepoPath("packages", "engine", "src", "import"), "*.ts").Order(StringComparer.Ordinal).Select(File.ReadAllText))
            + RepoFile("packages", "engine", "src", "steps", "parse.ts")
            + RepoFile("packages", "engine", "src", "steps", "desktop-vocabulary.ts");
        Assert.Matches($@"\bRECORDING_FORMAT = '{RecordingFile.Format}';", engine);
        Assert.Matches($@"\bMAX_RECORDING_EVENTS = {RecordingFile.MaxEvents};", engine);
        Assert.Matches($@"\bMAX_UIA_TEXT = {Texts.MaxText};", engine);
        Assert.Matches($@"\bMAX_START_VALUE = {Session.MaxStartValueLength};", engine);
        Assert.Matches($@"\bsteps\.length > {RecordingFile.MaxSteps}\)", engine);
        Assert.Matches($@"\bargs\.length <= {Session.MaxArgs} && args\.every\(\(a\) => typeof a === 'string' && a\.length <= {Session.MaxArgLength} ", engine);
    }

    [Fact]
    public void An_app_whose_path_is_not_a_program_is_refused()
    {
        Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\run.bat", [], Window)));
        Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\app.exe", ["{{$exportDir}}"], Window)));
    }

    [Fact]
    public void A_check_event_holds_the_state_it_sets()
    {
        var box = El("CheckBox", "1041", "Match case") with { IsChecked = false };
        var json = JsonDocument.Parse(Record(Click(1, box)).ToFile("Test").ToJson()).RootElement;
        var check = json.GetProperty("events")[1];
        Assert.Equal(["at", "kind", "target", "label", "checked"], check.EnumerateObject().Select(p => p.Name));
        Assert.Equal("check", check.GetProperty("kind").GetString());
        Assert.True(check.GetProperty("checked").GetBoolean());
    }

    [Fact]
    public void The_app_comes_from_its_launch_with_its_arguments()
    {
        var s = Record(new AppStarted(At(0), @"C:\Apps\Orders.exe", ["--ui", "v2"], Window), Click(1, Ok));
        var file = s.ToFile("Test");
        Assert.Equal("Orders.exe", file.Exe);
        Assert.Equal(["--ui", "v2"], file.Args);
        var json = JsonDocument.Parse(file.ToJson()).RootElement;
        Assert.Equal("""{"exe":"Orders.exe","args":["--ui","v2"]}""", json.GetProperty("app").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        var launch = json.GetProperty("events")[0];
        Assert.Equal(("launch", "Orders.exe", 2), (launch.GetProperty("kind").GetString(), launch.GetProperty("exe").GetString(), launch.GetProperty("args").GetArrayLength()));
    }

    [Fact]
    public void The_policy_change_allows_the_app_by_path_and_hash_and_declares_no_writes()
    {
        // The policy takes only absolute local paths, so the path is this platform's.
        var path = OperatingSystem.IsWindows() ? @"C:\Program Files\ERP Demo\ErpDemo.exe" : "/opt/ERP Demo/ErpDemo.exe";
        var s = Record(new AppStarted(At(0), path, ["--ui", "v2"], Window), Click(1, Ok));
        var change = s.ToPolicyChange(path, Sha);

        var keys = JsonDocument.Parse(change.ToJson()).RootElement.EnumerateObject().Select(p => p.Name);
        Assert.Equal(["allowedApps"], keys);
        var policy = RunnerPolicy.Parse(RunnerPolicyChange.Apply("", change.ToJson()).Json);
        var app = Assert.Single(policy.AllowedApps);
        Assert.Equal(("ErpDemo.exe", path, Sha.ToUpperInvariant()), (app.Exe, app.Path, app.Sha256));
        Assert.Equal(["--ui", "v2"], Assert.Single(app.AllowedArgs));
        Assert.Empty(policy.WriteControls);
        Assert.Empty(policy.GatedKeys);

        // Without arguments there is no allowedArgs; a hash that is not SHA-256, or another program, is refused.
        var plain = Record(new AppStarted(At(0), path, [], Window)).ToPolicyChange(path, Sha);
        Assert.DoesNotContain("allowedArgs", plain.ToJson());
        Assert.Throws<ArgumentException>(() => s.ToPolicyChange(path, "abc"));
        Assert.Throws<ArgumentException>(() => s.ToPolicyChange(path.Replace("ErpDemo", "Other"), Sha));
    }

    [Fact]
    public void A_variable_keeps_the_value_that_was_recorded_as_its_start_value_except_a_secret()
    {
        var s = Record(ErpDemoObservations.List());
        int Index(string intentStart) => s.Steps.Select((step, i) => (step, i)).First(x => StepText.Action(x.step).StartsWith(intentStart, StringComparison.Ordinal)).i;
        var company = Index("Choose");
        var dateFrom = Index("Type \"2026-01-20\"");
        s.MarkVariable(company, "in_CompanyCode");
        s.MarkVariable(dateFrom, "in_DateFrom");
        var file = s.ToFile("ERP Demo line items");
        Assert.Equal(new Dictionary<string, string> { ["in_CompanyCode"] = "2000", ["in_DateFrom"] = "2026-01-20" }, file.Variables);
        var json = JsonDocument.Parse(file.ToJson()).RootElement;
        Assert.Equal("""{"in_CompanyCode":"2000","in_DateFrom":"2026-01-20"}""", json.GetProperty("variables").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        // The secret variable the password field gave never has a start value.
        Assert.Equal(["password"], file.SecretVariables);
        Assert.False(json.GetProperty("variables").TryGetProperty("password", out _));

        // Made secret after it was a variable: no start value, and the typed value is gone.
        s.MarkSecret(dateFrom, "in_DateFrom");
        Assert.Equal(new Dictionary<string, string> { ["in_CompanyCode"] = "2000" }, s.ToFile("Test").Variables);
        Assert.DoesNotContain("2026-01-20", s.ToFile("Test").ToJson());
        // A deleted step takes its start value with it.
        s.Delete(company);
        Assert.Empty(s.ToFile("Test").Variables);
        Assert.DoesNotContain("variables", s.ToFile("Test").ToJson());
    }

    [Fact]
    public void A_value_the_importer_would_refuse_as_a_start_value_is_not_kept()
    {
        // More than one line, or longer than 500 characters: the variable starts empty (the person fills it in).
        var note = El("Edit", "txtNote", "Note");
        var s = Record(Typed(1, Name), Left(2, Name, "line one\nline two"), Typed(3, note), Left(4, note, new string('x', 501)));
        s.MarkVariable(0, "note");
        s.MarkVariable(1, "longText");
        Assert.Empty(s.ToFile("Test").Variables);
    }

    private static (Session Session, int Company, int DateFrom) ErpWithVariables()
    {
        var s = Record(ErpDemoObservations.List());
        int Index(string start) => s.Steps.Select((step, i) => (step, i)).First(x => StepText.Action(x.step).StartsWith(start, StringComparison.Ordinal)).i;
        return (s, Index("Choose"), Index("Type \"2026-01-20\""));
    }

    [Fact]
    public void A_step_marked_as_a_variable_and_then_as_a_secret_under_another_name_leaves_no_start_value()
    {
        var (s, company, dateFrom) = ErpWithVariables();
        s.MarkVariable(dateFrom, "a");
        // Another step still types the variable a, so the name stays in use after the first step is made secret.
        s.MarkVariable(company, "a");
        s.MarkSecret(dateFrom, "b");
        var file = s.ToFile("Test");
        Assert.DoesNotContain("2026-01-20", file.ToJson());
        Assert.Equal(new Dictionary<string, string> { ["a"] = "2000" }, file.Variables);
        Assert.Contains("b", file.SecretVariables);
    }

    [Fact]
    public void Deleting_a_step_removes_its_start_value()
    {
        var (s, company, dateFrom) = ErpWithVariables();
        s.MarkVariable(company, "in_CompanyCode");
        s.MarkVariable(dateFrom, "in_DateFrom");
        s.Delete(dateFrom);
        Assert.Equal(new Dictionary<string, string> { ["in_CompanyCode"] = "2000" }, s.ToFile("Test").Variables);
    }

    [Fact]
    public void Renaming_a_variable_moves_its_start_value()
    {
        var (s, company, _) = ErpWithVariables();
        s.MarkVariable(company, "first");
        s.MarkVariable(company, "in_CompanyCode");
        Assert.Equal(new Dictionary<string, string> { ["in_CompanyCode"] = "2000" }, s.ToFile("Test").Variables);
    }

    [Fact]
    public void Two_steps_that_share_a_name_start_with_the_first_steps_value_which_goes_with_that_step()
    {
        var (s, company, dateFrom) = ErpWithVariables();
        s.MarkVariable(dateFrom, "shared");
        s.MarkVariable(company, "shared");
        Assert.Equal(new Dictionary<string, string> { ["shared"] = "2026-01-20" }, s.ToFile("Test").Variables);
        s.Delete(dateFrom);
        Assert.Equal(new Dictionary<string, string> { ["shared"] = "2000" }, s.ToFile("Test").Variables);
    }

    [Fact]
    public void No_start_value_is_written_for_a_secret_variables_name()
    {
        // The password field's variable is secret; a variable of the same name on another step gets no start value.
        var (s, company, _) = ErpWithVariables();
        s.MarkVariable(company, "password");
        var file = s.ToFile("Test");
        Assert.Contains("password", file.SecretVariables);
        Assert.Empty(file.Variables);
    }

    [Fact]
    public void A_start_value_equal_to_a_value_that_was_made_secret_is_not_written()
    {
        var name = El("Edit", "txtName", "Name");
        var note = El("Edit", "txtNote", "Note");
        var s = Record(Typed(1, name), Left(2, name, "Same-Value-1"), Typed(3, note), Left(4, note, "Same-Value-1"));
        s.MarkSecret(0, "secretOne");
        s.MarkVariable(1, "plain");
        Assert.Empty(s.ToFile("Test").Variables);
        Assert.DoesNotContain("Same-Value-1", s.ToFile("Test").ToJson());
    }

    [Fact]
    public void The_recording_says_about_how_many_steps_it_makes()
    {
        Assert.Equal(17, Record(ErpDemoObservations.List()).ToFile("ERP Demo line items").EstimatedSteps);
        var many = new Session();
        for (var i = 0; i < 205; i++) many.Add(Click(i, El("Button", "btnNext", "Next")));
        var file = many.ToFile("Long");
        Assert.True(file.EstimatedSteps > RecordingFile.MaxSteps);
        Assert.Equal("The recording makes about 206 steps, and Import Steps takes at most 200: delete steps, or record the work in shorter parts.",
            Notices.TooManySteps(file.EstimatedSteps));
    }

    [Fact]
    public void A_recording_of_an_open_window_names_the_attached_program()
    {
        var s = new Session();
        s.Attach(@"C:\Apps\Orders.exe");
        s.Add(Click(1, El("Button", "btnOk", "OK"), window: new("helper.exe", "Helper", "HelperWindow")));
        var file = s.ToFile("Test");
        Assert.Equal(("Orders.exe", 0), (file.Exe, file.Args.Count));
        Assert.DoesNotContain(file.Events, e => e.Kind == StepKind.Launch);
        Assert.Throws<ArgumentException>(() => s.ToPolicyChange(@"C:\Apps\Other.exe", new string('a', 64)));
        Assert.Equal("Orders.exe", s.ToPolicyChange(@"C:\Apps\Orders.exe", new string('a', 64)).Exe);
        Assert.Throws<InvalidOperationException>(() => s.Attach(@"C:\Apps\Orders.exe"));
        Assert.Throws<ArgumentException>(() => new Session().Attach(@"C:\Apps\run.bat"));
    }

    [Fact]
    public void Arguments_the_importer_would_refuse_are_refused_at_start()
    {
        var tooMany = Enumerable.Range(0, 51).Select(i => $"a{i}").ToArray();
        var e = Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\app.exe", tooMany, Window)));
        Assert.StartsWith("A recording takes at most 50 arguments of at most 1000 characters each", e.Message);
        Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\app.exe", [new string('x', 1001)], Window)));
        Assert.Single(Record(new AppStarted(At(0), @"C:\Apps\app.exe", Enumerable.Range(0, 50).Select(i => new string('x', 1000)).ToArray(), Window)).Steps);
    }
}
