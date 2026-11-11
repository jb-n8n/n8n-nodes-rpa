using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>What the recorder must not write because the importer or the step parser would refuse it, and the limits
/// it says on the bar.</summary>
public class BranchReviewTests
{
    private const int Tab = 0x09, Escape = 0x1B, E = 0x45, Left = 0x25, S = 0x53;
    private static readonly ElementFacts Company = El("ComboBox", "cmbCompany", "Company code");

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

    [Fact]
    public void A_choice_of_an_empty_item_is_not_recorded()
    {
        var blank = El("ListItem", "", "", "", false, false, El("List", "1000", "Company code"), Company);
        Assert.Equal(["Click Company code"], Record(Click(1, Company), Click(2, blank)).Steps.Select(step => StepText.Action(step)));
        Assert.Empty(Record(Typed(1, Company), Left(2, Company, null, "")).Steps);
    }

    [Fact]
    public void Only_a_check_box_records_a_check()
    {
        foreach (var type in new[] { "ListItem", "TreeItem", "DataItem", "Button" })
        {
            var row = El(type, "row1", "Acme Paper Co") with { IsChecked = true };
            Assert.Equal(StepKind.Click, Record(Click(1, row)).Steps.Single().Kind);
        }
        Assert.Equal(StepKind.Click, Record(new Activated(At(1), Window, El("Button", "btnBold", "Bold") with { IsChecked = true })).Steps.Single().Kind);
        Assert.Equal(StepKind.Check, Record(Click(1, El("CheckBox", "chkAll", "All") with { IsChecked = true })).Steps.Single().Kind);
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
    public void A_password_field_cannot_be_read_into_the_runs_output()
    {
        var s = new Session();
        foreach (var field in new[] { El("Edit", "txtPassword", "Password", password: true), El("Edit", "txtPin", "PIN") })
            Assert.Throws<ArgumentException>(() => s.AddRead(field, Window, "out_secret"));
        Assert.Empty(s.Steps);
        Assert.Equal("F9 added nothing: a password box is never read.", Notices.PasswordNotRead);
    }

    [Fact]
    public void A_variables_or_a_reads_name_has_at_most_64_characters()
    {
        Assert.True(SecretRules.IsVariableName("a" + new string('b', 63)));
        Assert.False(SecretRules.IsVariableName("a" + new string('b', 64)));
        var s = Record(Typed(1, El("Edit", "txtName", "Name")), Left(2, El("Edit", "txtName", "Name"), "Ada"));
        var e = Assert.Throws<ArgumentException>(() => s.MarkVariable(0, new string('n', 65)));
        Assert.StartsWith("A variable's name starts with a letter or _, holds only letters, digits and _, and has at most 64 characters", e.Message);
        Assert.Throws<ArgumentException>(() => s.AddRead(El("Text", "lblCount", "6"), Window, new string('n', 65)));
    }

    [Fact]
    public void The_arguments_box_is_split_as_Windows_reads_a_command_line()
    {
        Assert.Equal(["--ui", "v2", @"C:\My Files\a.txt", "say \"hi\"", ""], CommandLine.Split("--ui v2 \"C:\\My Files\\a.txt\" \"say \\\"hi\\\"\" \"\""));
        Assert.Equal([@"C:\data\", "x"], CommandLine.Split(@"  C:\data\   x "));
        Assert.Empty(CommandLine.Split("   "));
        foreach (var args in new[] { new[] { "a b", "", "c\\", "d\\\"e", "\"", "f\\\\ g\\" }, ["plain"], [] })
            Assert.Equal(args, CommandLine.Split(CommandLine.JoinArguments(args)));
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

    [Fact]
    public void A_field_whose_value_could_not_be_read_is_named_in_a_notice()
    {
        Assert.Equal("The value typed into \"Notes\" could not be read, so that step is not in the recording: add it by hand.", Notices.NotRead("Notes"));
    }
}
