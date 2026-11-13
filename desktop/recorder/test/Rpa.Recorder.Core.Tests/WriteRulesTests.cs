using System.Text.Json;
using System.Text.RegularExpressions;
using Rpa.Runner.Core.Policy;
using static Rpa.Recorder.Core.Tests.Fakes;
using RunnerPolicyChange = Rpa.Runner.Core.Policy.PolicyChange;

namespace Rpa.Recorder.Core.Tests;

public class WriteRulesTests
{
    private static readonly string Sha = new('a', 64);
    private static readonly string ErpPath = OperatingSystem.IsWindows() ? ErpDemoObservations.ExePath : "/opt/ERP Demo/ErpDemo.exe";
    private static readonly WindowFacts Main = new("erpdemo.exe", "ERP Demo - Line items", WinFormsClass);
    private static readonly ElementFacts Post = El("Button", "btnPost", "Post", "WindowsForms10.Button.app.0.19fd5c7_r3_ad1");

    private static RecordedCondition C(string? type, string? id, string? name) => new(type, id, name);

    private static RecordedStep ClickOn(string label, params RecordedCondition[] path) =>
        new(StepKind.Click, T0, label) { Target = new RecordedTarget(new RecordedWindow("app.exe", "App", null), path) };

    [Fact]
    public void The_words_are_the_engines_word_for_word()
    {
        // packages/engine/src/proposal/desktop.ts: the rule that pre-ticks the review page's "Which of these steps save,
        // send or submit?". The recorder proposes to protect what that rule ticks.
        var ts = RepoFile("packages", "engine", "src", "proposal", "desktop.ts");
        var words = Regex.Match(ts, @"const WRITE_WORDS = /\\b\((?<w>[a-z|]+)\)\\b/i;").Groups["w"].Value;
        Assert.Equal(WriteRules.Words, words);
        Assert.Contains("const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\\-]+/g, ' ');", ts);
        Assert.Contains("return conds.map((c) => `${c.name ?? ''} ${words(c.automationId ?? '')}`).join(' ');", ts);
        Assert.Contains("if ('click' in step) return WRITE_WORDS.test(words(step.intent)) || WRITE_WORDS.test(locatorWords(step.click));", ts);
        Assert.Contains("if ('doubleClick' in step) return WRITE_WORDS.test(words(step.intent)) || WRITE_WORDS.test(locatorWords(step.doubleClick));", ts);
        // The intent holds the label as cleanLabel leaves it (packages/engine/src/import/draft.ts).
        var draft = RepoFile("packages", "engine", "src", "import", "draft.ts");
        Assert.Contains($"export const MAX_LABEL = {WriteRules.MaxLabel};", draft);
        Assert.Contains("const FORMAT_CHARS = /[\\p{Cf}\\p{Cs}]/gu;", draft);
        Assert.Contains("const CONTROL_CHARS = /[\\p{Cc}\\u2028\\u2029]/gu;", draft);
    }

    [Theory]
    [InlineData("Post", true)]
    [InlineData("Save as", true)]
    [InlineData("OK", true)]
    [InlineData("SAVE", true)]
    [InlineData("btnPost", true)]
    [InlineData("save_as", true)]
    [InlineData("btn.Delete", true)]
    [InlineData("Posting", true)]
    [InlineData("Search", false)]
    [InlineData("Saved", false)]
    [InlineData("Postal code", false)]
    [InlineData("btnPosted", false)]
    [InlineData("Booking", false)]
    [InlineData("savebutton", false)]
    [InlineData("Continue", false)]
    // JavaScript's \b and /i: a letter outside ASCII is no word character, and only ASCII letters match without case.
    [InlineData("Post\u00E9", true)]
    [InlineData("\u017Fave", false)]
    [InlineData("boo\u212A", false)]
    public void A_text_looks_like_a_write_as_the_engine_reads_it(string text, bool write) =>
        Assert.Equal(write, WriteRules.HasWriteWord(WriteRules.SplitWords(text)));

    [Fact]
    public void A_click_looks_like_a_write_by_its_label_or_by_a_condition_of_its_path()
    {
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Post", C("Button", "btnPost", "Post"))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Go", C("Button", "btnSubmitOrder", "Go"))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Go", C("Pane", "pnlApprove", null), C("Button", "btnGo", "Go"))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Send now", C("Button", null, null))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Post", C("Button", "btnPost", "Post")) with { Double = true }));
        Assert.False(WriteRules.LooksLikeWrite(ClickOn("Search", C("Button", "btnSearch", "Search"))));
        // The name of a condition is read as it is (the engine splits only the id), the label as words.
        Assert.False(WriteRules.LooksLikeWrite(ClickOn("x", C("Button", null, "quickSave"))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("quickSave", C("Button", null, null))));
        // The engine's intent holds at most 80 characters of the label.
        Assert.False(WriteRules.LooksLikeWrite(ClickOn(new string('x', 79) + " Save", C("Button", null, null))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn(new string('x', 74) + " Save", C("Button", null, null))));
        Assert.True(WriteRules.LooksLikeWrite(ClickOn("Po\u200Bst", C("Button", null, null))));
        // Only clicks: a fill, a key and a check are never proposed.
        Assert.False(WriteRules.LooksLikeWrite(new RecordedStep(StepKind.Fill, T0, "Post") { Target = ClickOn("Post", C("Edit", "txtPost", "Post")).Target }));
        Assert.False(WriteRules.LooksLikeWrite(new RecordedStep(StepKind.Key, T0, "Post") { Chord = "Enter" }));
        Assert.False(WriteRules.LooksLikeWrite(new RecordedStep(StepKind.Check, T0, "Post") { Target = ClickOn("Post", C("CheckBox", "chkPost", "Post")).Target }));
    }

    [Fact]
    public void The_dialog_button_ids_are_the_policy_tools()
    {
        foreach (var id in Enumerable.Range(0, 1200).Select(n => n.ToString(System.Globalization.CultureInfo.InvariantCulture))
                     .Concat(["", "01", "1 ", " 1", "1.0", "+1", "-1", "IDOK", "\u0661", "btnPost"]))
            Assert.Equal(RunnerPolicyChange.IsDialogButtonId(id), WriteRules.IsDialogButtonId(id));
        Assert.True(WriteRules.IsDialogButtonId("1"));
        Assert.True(WriteRules.IsDialogButtonId("11"));
        Assert.False(WriteRules.IsDialogButtonId("12"));
        Assert.False(WriteRules.IsDialogButtonId("1001"));
    }

    [Fact]
    public void The_limits_of_a_change_are_the_policy_tools()
    {
        Assert.Equal(RunnerPolicyChange.MaxEntries, Rpa.Recorder.Core.PolicyChange.MaxEntries);
        Assert.Equal(RunnerPolicyChange.MaxValueLength, Rpa.Recorder.Core.PolicyChange.MaxValueLength);
    }

    [Fact]
    public void The_ERP_Demo_flow_with_Post_proposes_Post_and_leaves_out_the_Save_dialogs_button()
    {
        var list = ErpDemoObservations.List().ToList();
        // After the result cell, the person clicks Post.
        var cell = list.FindIndex(o => o is MouseDown { Element.Name: "Vendor Row 1" });
        list.Insert(cell + 1, new MouseDown(Parse("22:59:30.9"), Main, Post, 1));
        var change = Record([.. list]).ToPolicyChange(ErpPath, Sha);

        Assert.Equal([new ProposedControl("ErpDemo.exe", "btnPost", "Post")], change.WriteControls);
        Assert.Equal([new ProposedControl("ErpDemo.exe", "1", "Save")], change.LeftOut);
        var json = JsonDocument.Parse(change.ToJson()).RootElement;
        Assert.Equal(["allowedApps", "writeControls", "leftOutControls"], json.EnumerateObject().Select(p => p.Name));
        Assert.Equal("""[{"exe":"ErpDemo.exe","automationId":"btnPost","name":"Post"}]""", json.GetProperty("writeControls").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        Assert.Equal("""[{"exe":"ErpDemo.exe","automationId":"1","name":"Save"}]""", json.GetProperty("leftOutControls").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));

        // The policy tool takes it as it is: one question for the app and the button; the left-out one is said, not kept.
        var applied = RunnerPolicyChange.Apply("", change.ToJson());
        Assert.Contains("Protect \"Post\" (\"btnPost\") of \"ErpDemo.exe\" as a write control", applied.Summary);
        Assert.Contains(applied.Summary, line => line.StartsWith("Not protected: \"Save\" (\"1\") of \"ErpDemo.exe\"", StringComparison.Ordinal));
        var policy = RunnerPolicy.Parse(applied.Json);
        Assert.Equal(("ErpDemo.exe", "btnPost"), (Assert.Single(policy.WriteControls).Exe, policy.WriteControls[0].AutomationId));
        Assert.Empty(policy.GatedKeys);
    }

    [Fact]
    public void The_ERP_Demo_flow_without_Post_proposes_nothing_and_its_Enter_is_no_gated_key()
    {
        var change = Record(ErpDemoObservations.List()).ToPolicyChange(ErpPath, Sha);
        Assert.Empty(change.WriteControls);
        Assert.Equal([new ProposedControl("ErpDemo.exe", "1", "Save")], change.LeftOut);
        Assert.DoesNotContain("writeControls", change.ToJson());
        Assert.DoesNotContain("gatedKeys", change.ToJson());
    }

    [Fact]
    public void Proposes_each_control_once_by_the_id_that_finds_it_and_only_the_recorded_apps()
    {
        var other = new WindowFacts("other.exe", "Other", "OtherWindow");
        var s = Record(
            new AppStarted(At(0), ErpPath, [], Main),
            Click(1, Post, window: Main), Click(5, Post, window: Main),
            // A control without an id, one with a generated id, and one of another program: nothing to protect.
            Click(9, El("Button", "", "Save"), window: Main),
            Click(13, El("Button", "Save_3f2a9c1e4b7d", "Save"), window: Main),
            Click(17, El("Button", "btnSend", "Send"), window: other),
            Click(21, El("Button", "btnApprove", "Approve"), window: Main),
            Click(25, El("Button", "2", "Cancel"), window: Main),
            Click(29, El("Button", "6", "Yes"), window: Main),
            Click(33, El("Button", "btnSearch", "Search"), window: Main));
        var change = s.ToPolicyChange(ErpPath, Sha);
        Assert.Equal([new ProposedControl("ErpDemo.exe", "btnPost", "Post"), new ProposedControl("ErpDemo.exe", "btnApprove", "Approve")], change.WriteControls);
        // Cancel is no write word; Yes is, and 6 is a standard dialog button's id.
        Assert.Equal([new ProposedControl("ErpDemo.exe", "6", "Yes")], change.LeftOut);

        // A step deleted from the bar proposes nothing.
        var approve = s.Steps.Select((step, i) => (step, i)).First(x => x.step.Target?.Path[^1].AutomationId == "btnApprove").i;
        s.Delete(approve);
        Assert.Equal(["btnPost"], s.ToPolicyChange(ErpPath, Sha).WriteControls.Select(c => c.AutomationId));
    }

    [Fact]
    public void Keeps_the_change_within_the_policy_tools_limits()
    {
        var steps = new List<Observation> { new AppStarted(At(0), ErpPath, ["--ui", "v2"], Main) };
        for (var i = 0; i < 45; i++) steps.Add(Click(4 * i + 1, El("Button", $"btnSave{i}", "Save " + new string('x', 300)), window: Main));
        steps.Add(Click(400, El("Button", "1", "OK"), window: Main));
        steps.Add(Click(404, El("Button", "btnPost" + new string('x', RunnerPolicyChange.MaxValueLength), "Post"), window: Main));
        var change = Record([.. steps]).ToPolicyChange(ErpPath, Sha);
        // The app and its argument list are two entries: 38 controls fill the 40.
        Assert.Equal(38, change.WriteControls.Count + change.LeftOut.Count);
        Assert.Empty(change.LeftOut);
        Assert.All(change.WriteControls, c => Assert.True(c.Name.Length <= Rpa.Recorder.Core.PolicyChange.MaxNameLength));
        Assert.DoesNotContain(change.WriteControls, c => c.AutomationId.StartsWith("btnPostx", StringComparison.Ordinal));
        Assert.NotEmpty(RunnerPolicyChange.Apply("", change.ToJson()).Summary);
    }
}
