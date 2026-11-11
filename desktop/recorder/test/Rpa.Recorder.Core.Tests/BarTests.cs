using System.Drawing;

namespace Rpa.Recorder.Core.Tests;

/// <summary>What the bar says and shows at each stage, its notices, where it saves, what it says to do after saving,
/// and where its windows open.</summary>
public class BarTests
{
    private const string Erp = @"C:\Program Files\ERP Demo\ErpDemo.exe";
    private static readonly char S = Path.DirectorySeparatorChar;
    private static readonly string Root = OperatingSystem.IsWindows() ? @"C:\Program Files" : "/opt/Program Files";
    private static readonly string Documents = OperatingSystem.IsWindows() ? @"C:\Users\clerk\Documents" : "/home/clerk/Documents";

    [Fact]
    public void The_state_line_says_the_stage_in_words_with_the_step_count()
    {
        Assert.Equal("Ready", BarText.StateLine(BarStage.Ready, null, 0));
        Assert.Equal("Starting ErpDemo.exe…", BarText.StateLine(BarStage.Starting, Erp, 0));
        Assert.Equal("Recording ErpDemo.exe · 9 steps", BarText.StateLine(BarStage.Recording, Erp, 9));
        Assert.Equal("Recording ErpDemo.exe · 1 step", BarText.StateLine(BarStage.Recording, Erp, 1));
        Assert.Equal("Recording ErpDemo.exe · no steps yet", BarText.StateLine(BarStage.Recording, Erp, 0));
        Assert.Equal("Paused · 9 steps", BarText.StateLine(BarStage.Paused, Erp, 9));
        Assert.Equal("Finished · 13 steps", BarText.StateLine(BarStage.Finished, Erp, 13));
        Assert.Equal("Saved · 13 steps", BarText.StateLine(BarStage.Saved, Erp, 13));
        // The page that asks which values change comes before the name and Save.
        Assert.Equal("Almost done · 13 steps", BarText.StateLine(BarStage.Values, Erp, 13));
        Assert.Equal([BarColor.Neutral, BarColor.Neutral, BarColor.Recording, BarColor.Paused, BarColor.Neutral, BarColor.Neutral, BarColor.Neutral],
            Enum.GetValues<BarStage>().Select(BarText.Color));
    }

    [Fact]
    public void Under_the_state_line_one_sentence_says_what_to_do_now()
    {
        Assert.Equal("Choose the app to record.", BarText.Guidance(BarStage.Ready));
        Assert.Equal("Wait for its window: recording starts when it shows.", BarText.Guidance(BarStage.Starting));
        Assert.Equal("Do the work in the app. Each step appears in the list below.", BarText.Guidance(BarStage.Recording));
        Assert.Equal("Nothing is recorded until you resume.", BarText.Guidance(BarStage.Paused));
        Assert.Equal("Check the steps, then name the recording and save it.", BarText.Guidance(BarStage.Finished));
        Assert.Equal($"Saved ERP line items.rpa-recording.json in Documents{S}RPA recordings. Two things are left to do:",
            BarText.Guidance(BarStage.Saved, "ERP line items.rpa-recording.json", $"Documents{S}RPA recordings"));
        Assert.Equal(
        [
            "Your clicks and what you type in that app become steps, listed here as plain sentences.",
            "Clicks on this window are never recorded, and password boxes are never read.",
        ], BarText.ReadySentences(narrow: false));
        // On a small screen the bar may cover the app.
        Assert.Equal("Clicks on this window are never recorded, and password boxes are never read. Drag this window if it covers the app.",
            BarText.ReadySentences(narrow: true)[1]);
    }

    [Fact]
    public void Each_stage_shows_only_what_belongs_to_it_and_has_at_most_one_primary_button()
    {
        Assert.Equal(BarPart.StartButtons | BarPart.ReadyText | BarPart.List, BarText.Parts(BarStage.Ready));
        Assert.Equal(BarPart.List, BarText.Parts(BarStage.Starting));
        Assert.Equal(BarPart.RecordButtons | BarPart.List | BarPart.ReadHint | BarPart.StepActions, BarText.Parts(BarStage.Recording));
        Assert.Equal(BarPart.RecordButtons | BarPart.List | BarPart.ReadHint | BarPart.StepActions, BarText.Parts(BarStage.Paused));
        // Once finished, the step actions show only for a selected step: they belong to editing.
        Assert.Equal(BarPart.List | BarPart.SaveBlock, BarText.Parts(BarStage.Finished));
        Assert.Equal(BarPart.List | BarPart.NextSteps, BarText.Parts(BarStage.Saved));
        Assert.Equal(BarPart.List | BarPart.StepActions | BarPart.NextSteps, BarText.Parts(BarStage.Saved, stepSelected: true));
        Assert.Equal(BarPart.List | BarPart.StepActions | BarPart.SaveBlock, BarText.Parts(BarStage.Finished, stepSelected: true));
        // Between Finish and the name: the page that asks which values change, in place of the list.
        Assert.Equal(BarPart.ValuesPage, BarText.Parts(BarStage.Values));
        Assert.Equal(BarPart.ValuesPage, BarText.Parts(BarStage.Values, stepSelected: true));

        // The empty list says what comes there wherever it shows, from the very first Ready on (decided from the parts:
        // before the window is shown, every control in it reads as hidden).
        Assert.Equal([true, true, true, true, false, true, true], Enum.GetValues<BarStage>().Select(s => BarText.ShowsEmptyList(BarText.Parts(s), 0)));
        Assert.False(BarText.ShowsEmptyList(BarText.Parts(BarStage.Ready), 1));
        Assert.False(BarText.ShowsEmptyList(BarText.Parts(BarStage.Recording), 3));

        // The list keeps at least six rows wherever it shows steps.
        Assert.Equal([0, 0, 6, 6, 0, 6, 6], Enum.GetValues<BarStage>().Select(BarText.MinListRows));

        // Back: from the values page to the list, paused, while the recording can resume; once it has ended (the page
        // opened again from Finished), back to Finished. From Finished to the values page when it has a value to offer.
        // Not after saving: Record another is the way to change a recording then.
        RecordedStep[] typed = [new(StepKind.Fill, DateTimeOffset.Now, "Date to") { Value = "2026-11-30" }];
        RecordedStep[] clicked = [new(StepKind.Click, DateTimeOffset.Now, "Search")];
        Assert.Equal(BarStage.Paused, BarText.Back(BarStage.Values, ended: false, typed));
        Assert.Equal(BarStage.Finished, BarText.Back(BarStage.Values, ended: true, typed));
        Assert.Equal(BarStage.Values, BarText.Back(BarStage.Finished, ended: true, typed));
        Assert.Null(BarText.Back(BarStage.Finished, ended: true, clicked));
        foreach (var stage in new[] { BarStage.Ready, BarStage.Starting, BarStage.Recording, BarStage.Paused, BarStage.Saved })
            Assert.Null(BarText.Back(stage, ended: true, typed));
        Assert.Equal(BarText.Save, BarText.Primary(BarStage.Finished));

        Assert.Equal("Pause", BarText.PauseButton(BarStage.Recording));
        Assert.Equal("Resume", BarText.PauseButton(BarStage.Paused));

        var tool = Path.Combine(Root, "RPA Runner", "runner", "RpaPolicy.exe");
        var change = Path.Combine(Documents, "RPA recordings", "x.policy-change.json");
        Assert.Equal(BarText.StartApp, BarText.Primary(BarStage.Ready));
        Assert.Null(BarText.Primary(BarStage.Starting));
        // While recording, Enter in the bar must not finish the recording.
        Assert.Null(BarText.Primary(BarStage.Recording));
        Assert.Null(BarText.Primary(BarStage.Paused));
        Assert.Equal(BarText.Save, BarText.Primary(BarStage.Finished));
        Assert.Equal(ValuesPage.Continue, BarText.Primary(BarStage.Values));
        Assert.Equal(NextSteps.AllowButton, BarText.Primary(BarStage.Saved, NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.NotDone)));
        Assert.Equal(NextSteps.ShowFile, BarText.Primary(BarStage.Saved, NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.Allowed)));
        Assert.Equal(NextSteps.ShowFile, BarText.Primary(BarStage.Saved, NextSteps.Allow("ErpDemo.exe", null, change, AllowState.NotDone)));
        // While the policy tool waits for its answer, Enter in the bar does nothing: an Enter meant for the tool's window
        // must not open Explorer.
        Assert.Null(BarText.Primary(BarStage.Saved, NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.Waiting)));
    }

    [Fact]
    public void An_action_keeps_its_name_everywhere()
    {
        Assert.Equal("Start an app…", BarText.StartApp);
        Assert.Equal("Start an app", DialogText.StartTitle);
        // Short, so that it fits beside Start an app… on a bar 360 wide; its window keeps the longer title.
        Assert.Equal("Use an open app…", BarText.UseOpenApp);
        Assert.Equal("Use an app that is already open", DialogText.OpenTitle);
        // A variable is made on the values page only; a secret can be made on the bar too (before saving, while recording).
        Assert.Equal(("Delete step", "Make secret…"), (BarText.DeleteStep, BarText.MakeSecret));
        Assert.Equal("Earlier notices", DialogText.NoticesTitle);
        // A screen reader names the list and the values page by these, not after a label near them.
        Assert.Equal(("Recorded steps", "Values that can change"), (BarText.ListName, ValuesPage.AreaName));
        // And the panes around the list and around the step buttons, which would otherwise take a hidden label's name.
        Assert.Equal("Step actions", BarText.StepActionsName);
        Assert.Equal(BarText.ListName, BarText.ListAreaName(BarText.Parts(BarStage.Recording)));
        Assert.Equal(BarText.ListName, BarText.ListAreaName(BarText.Parts(BarStage.Finished)));
        Assert.Equal(ValuesPage.AreaName, BarText.ListAreaName(BarText.Parts(BarStage.Values)));
        Assert.Equal("Record another", DialogText.StartOverUnsaved(2).Title);
        Assert.Equal(BarText.RecordAnother, DialogText.StartOverUnsaved(2).Title);
        // No label is written in capitals.
        foreach (var text in new[] { BarText.StartApp, BarText.UseOpenApp, BarText.Finish, BarText.Save, BarText.ChangeFolder, BarText.RecordAnother, BarText.ReadHint, NextSteps.AllowButton, NextSteps.ShowFile, ValuesPage.Continue, ValuesPage.Back })
            Assert.NotEqual(text.ToUpperInvariant(), text);
    }

    [Fact]
    public void The_start_question_checks_the_program_and_its_arguments_before_anything_starts()
    {
        Func<string, bool> exists = path => path == Erp;
        Assert.Null(DialogText.StartProblem(Erp, "", exists));
        Assert.Null(DialogText.StartProblem(Erp, "--ui \"v 2\"", exists));
        Assert.Equal("Choose the app's program file (.exe).", DialogText.StartProblem("  ", "", exists));
        Assert.Equal("The app must be a program file (.exe).", DialogText.StartProblem(@"C:\notes.txt", "", _ => true));
        Assert.Equal(@"There is no program at C:\Apps\Gone.exe.", DialogText.StartProblem(@"C:\Apps\Gone.exe", "", exists));
        Assert.Equal("The arguments may not hold {{.", DialogText.StartProblem(Erp, "{{var.x}}", exists));
        Assert.Equal("A recording takes at most 50 arguments of at most 1000 characters each.", DialogText.StartProblem(Erp, string.Join(' ', Enumerable.Repeat("a", 51)), exists));
        Assert.Equal("A recording takes at most 50 arguments of at most 1000 characters each.", DialogText.StartProblem(Erp, new string('a', 1001), exists));
        Assert.Equal("Arguments (optional)", DialogText.StartArguments);
        Assert.Equal("Do not put a password here: arguments are saved in the recording.", DialogText.ArgumentsNote);
    }

    [Fact]
    public void The_questions_before_work_is_lost_say_how_many_steps()
    {
        var close = DialogText.CloseUnsaved(13);
        Assert.Equal(("Close the recorder", "The 13 recorded steps are not saved. Close the recorder and lose them?", "Close without saving"), (close.Title, close.Text, close.Action));
        Assert.Equal("The recorded step is not saved. Close the recorder and lose it?", DialogText.CloseUnsaved(1).Text);
        var again = DialogText.StartOverUnsaved(13);
        Assert.Equal(("The 13 recorded steps are not saved. Start a new recording and lose them?", "Start over"), (again.Text, again.Action));
        var replace = DialogText.Replace($"Documents{S}RPA recordings", ["a.rpa-recording.json", "a.policy-change.json"]);
        Assert.Equal(("Replace the saved files", $"Documents{S}RPA recordings already has a.rpa-recording.json and a.policy-change.json. Replace them?", "Replace"),
            (replace.Title, replace.Text, replace.Action));
        Assert.Equal($"Documents{S}RPA recordings already has a.policy-change.json. Replace it?", DialogText.Replace($"Documents{S}RPA recordings", ["a.policy-change.json"]).Text);
    }

    [Fact]
    public void The_notice_line_shows_the_newest_notice_and_keeps_the_others()
    {
        var line = new NoticeLine();
        Assert.Null(line.Current);
        Assert.Null(line.EarlierLink);
        var t = new DateTimeOffset(2026, 11, 11, 14, 47, 13, TimeSpan.Zero);
        line.Add(new BarNotice(t, "First", NoticeTone.Check));
        line.Add(new BarNotice(t.AddSeconds(5), "Second", NoticeTone.Information));
        line.Add(new BarNotice(t.AddSeconds(9), "Third", NoticeTone.Check));
        Assert.Equal("Third", line.Current!.Text);
        Assert.Equal(["Second", "First"], line.All.Skip(1).Select(n => n.Text));
        Assert.Equal("Earlier notices (2)", line.EarlierLink);
        Assert.Equal("14:47:18  Second", NoticeLine.Listed(line.All[1]));
        // The list behind the link holds the notice on the line too: a long one is cut there.
        Assert.Equal(["Third", "Second", "First"], line.All.Select(n => n.Text));

        // The same notice again replaces itself instead of filling the list.
        line.Add(new BarNotice(t.AddSeconds(20), "Third", NoticeTone.Check));
        Assert.Equal((2, t.AddSeconds(20)), (line.All.Count - 1, line.Current!.At));

        for (var i = 0; i < 150; i++) line.Add(new BarNotice(t, $"n{i}", NoticeTone.Information));
        Assert.Equal(NoticeLine.MaxKept, line.All.Count);
        line.Clear();
        Assert.Null(line.Current);
        Assert.Empty(line.All);
    }

    [Fact]
    public void A_notice_is_amber_when_the_person_should_check_something_and_plain_when_it_only_informs()
    {
        Assert.Equal(NoticeTone.Information, NoticeLine.Tone(NoticeKind.OtherProgram));
        foreach (var kind in Enum.GetValues<NoticeKind>().Where(k => k != NoticeKind.OtherProgram)) Assert.Equal(NoticeTone.Check, NoticeLine.Tone(kind));
    }

    [Fact]
    public void Notices_say_what_happened_and_what_to_do_in_at_most_140_characters()
    {
        string[] texts =
        [
            Notices.CtrlAltDropped, Notices.ProgramUnknown, Notices.PasswordNotRead, Notices.NotRead("Notes"), Notices.TooManySteps(206),
            Notices.OtherPrograms, Notices.Elevated, Notices.HookLost, Notices.Late("Search"), Notices.NotStarted, Notices.DidNotStart("Access is denied."),
            Notices.SaveKeepsFolder,
        ];
        foreach (var text in texts)
        {
            Assert.True(text.Length <= 140, text);
            Assert.EndsWith(".", text);
        }
        Assert.Equal("A Ctrl+Alt shortcut was not recorded: on many keyboards Ctrl+Alt types characters. Use the app's menu for that step.", Notices.CtrlAltDropped);
        Assert.Equal("Check the step on \"Search\": the app answered late, so it was recorded as it was then. Delete it if it is wrong.", Notices.Late("Search"));
        Assert.Equal("F9 added nothing: a password box is never read.", Notices.PasswordNotRead);
    }

    [Fact]
    public void The_Ctrl_Alt_notice_appears_only_when_such_a_key_was_pressed_and_dropped()
    {
        // Ctrl+Alt with a letter types a character on many keyboards: in a field it is typing, elsewhere it is dropped.
        Assert.True(Notices.ShortcutDropped(ctrl: true, alt: true, KeyKind.Printable, FieldKind.None));
        Assert.False(Notices.ShortcutDropped(ctrl: true, alt: true, KeyKind.Printable, FieldKind.Text));
        Assert.False(Notices.ShortcutDropped(ctrl: true, alt: true, KeyKind.Printable, FieldKind.DropDown));
        Assert.False(Notices.ShortcutDropped(ctrl: true, alt: false, KeyKind.Command, FieldKind.None));
        Assert.False(Notices.ShortcutDropped(ctrl: false, alt: false, KeyKind.Printable, FieldKind.None));
        Assert.False(Notices.ShortcutDropped(ctrl: true, alt: true, KeyKind.EditChord, FieldKind.None));
        Assert.Equal(KeyKind.Printable, KeyRules.Kind(0x45, ctrl: true, alt: true));
    }

    [Fact]
    public void Save_goes_to_Documents_RPA_recordings_by_default_and_shows_the_folder_short()
    {
        var folder = SaveNames.DefaultFolder(Documents);
        Assert.Equal(Path.Combine(Documents, "RPA recordings"), folder);
        Assert.Equal($"Documents{S}RPA recordings", SaveNames.FolderShown(folder, Documents));
        Assert.Equal($"Documents{S}work", SaveNames.FolderShown(Path.Combine(Documents, "work"), Documents));
        Assert.Equal("Documents", SaveNames.FolderShown(Documents, Documents));
        var elsewhere = Path.Combine(Path.GetDirectoryName(Documents)!, "Desktop");
        Assert.Equal(elsewhere, SaveNames.FolderShown(elsewhere, Documents));
        // A folder whose name only starts like Documents is not inside it.
        Assert.Equal(Documents + "2", SaveNames.FolderShown(Documents + "2", Documents));
        Assert.Equal($"Folder: Documents{S}RPA recordings", SaveNames.FolderLine($"Documents{S}RPA recordings"));
        Assert.Equal("Type a name for the recording, then choose Save.", SaveNames.NameMissing);
        Assert.Equal("Not saved: the name must be one line.", SaveNames.NotSaved("the name must be one line."));
        Assert.Equal($"Not saved: the folder Documents{S}RPA recordings could not be created (Access is denied.).",
            SaveNames.NotSaved($"the folder Documents{S}RPA recordings could not be created (Access is denied.)."));

        Assert.Equal("ErpDemo recording", SaveNames.SuggestedName(Erp));
        Assert.Equal("Recording", SaveNames.SuggestedName(null));
        Assert.Equal("ErpDemo recording.rpa-recording.json", SaveNames.Recording(SaveNames.SuggestedName(Erp)));
    }

    [Fact]
    public void After_saving_the_bar_says_how_to_allow_the_app_and_how_to_import_the_recording()
    {
        var tool = Path.Combine(Root, "RPA Runner", "runner", "RpaPolicy.exe");
        var change = Path.Combine(Documents, "RPA recordings", "ERP line items.policy-change.json");

        Assert.Equal(new NextLine("1. Allow ErpDemo.exe on this machine", "The policy tool opens as administrator. It shows what it will allow and asks you.", "Allow this app…", null, true),
            NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.NotDone));
        Assert.Equal(new NextLine("1. Allow ErpDemo.exe on this machine", "The policy tool is open in its own window: answer there.", "Allow this app…", null, false),
            NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.Waiting));
        Assert.Equal(new NextLine("1. ErpDemo.exe is allowed on this machine", "The policy tool reported success.", null, null, false),
            NextSteps.Allow("ErpDemo.exe", tool, change, AllowState.Allowed));
        // A copy of the recorder outside an install: an administrator applies the file.
        Assert.Equal(new NextLine("1. Allow ErpDemo.exe on this machine", "Give ERP line items.policy-change.json to an administrator of this machine, who runs:",
                null, $"RpaPolicy.exe apply \"{change}\"", false),
            NextSteps.Allow("ErpDemo.exe", null, change, AllowState.NotDone));

        // The steps the import adds are said on n8n's review page, where they show.
        Assert.Equal(new NextLine("2. Import the recording in n8n", "Upload it in n8n's Import a bot form.", "Show the file", null, true), NextSteps.Import());
    }

    [Fact]
    public void The_policy_tool_is_the_one_of_the_install_beside_the_recorder_under_Program_Files()
    {
        var recorder = Path.Combine(Root, "RPA Runner", "recorder") + S;
        var tool = Path.Combine(Root, "RPA Runner", "runner", "RpaPolicy.exe");
        Assert.Equal(tool, NextSteps.FindPolicyTool(recorder, Root, path => path == tool));
        Assert.Equal(tool, NextSteps.FindPolicyTool(recorder.TrimEnd(S), Root + S, path => path == tool));
        Assert.Null(NextSteps.FindPolicyTool(recorder, Root, _ => false));
        // A copy of the recorder in a folder its user can change: a program found beside it is not started as administrator.
        var copy = Path.Combine(Documents, "tools", "recorder");
        Assert.Null(NextSteps.FindPolicyTool(copy, Root, _ => true));
        Assert.Null(NextSteps.FindPolicyTool(Path.Combine(Root + "x", "RPA Runner", "recorder"), Root, _ => true));
    }

    [Fact]
    public void The_policy_tool_gets_the_change_file_as_one_argument_and_its_exit_code_is_said_plainly()
    {
        Assert.Equal("apply \"C:\\Users\\clerk\\Documents\\RPA recordings\\a b.policy-change.json\"",
            NextSteps.ApplyArguments(@"C:\Users\clerk\Documents\RPA recordings\a b.policy-change.json"));
        Assert.Equal(["apply", @"C:\Users\clerk\Documents\RPA recordings\a b.policy-change.json"],
            CommandLine.Split(NextSteps.ApplyArguments(@"C:\Users\clerk\Documents\RPA recordings\a b.policy-change.json")));
        // Started by the bar, the tool's window closes by itself after a successful apply; the command for an
        // administrator (ApplyArguments) waits as the tool run by hand does.
        Assert.Equal(["apply", @"C:\Users\clerk\Documents\RPA recordings\a b.policy-change.json", "--close-on-success"],
            CommandLine.Split(NextSteps.StartArguments(@"C:\Users\clerk\Documents\RPA recordings\a b.policy-change.json")));
        Assert.Equal("/select,\"C:\\Users\\clerk\\Documents\\RPA recordings\\a.rpa-recording.json\"",
            NextSteps.ExplorerSelect(@"C:\Users\clerk\Documents\RPA recordings\a.rpa-recording.json"));

        Assert.Equal(new AllowOutcome(true, null, NoticeTone.Information), NextSteps.Outcome(0));
        Assert.Equal(new AllowOutcome(false, "You answered no in the policy tool, so nothing was changed. Choose Allow this app… to try again.", NoticeTone.Information),
            NextSteps.Outcome(3));
        Assert.Equal(new AllowOutcome(false, "The policy tool did not change the policy; its window said why. Choose Allow this app… to try again, or give the file to an administrator.", NoticeTone.Check),
            NextSteps.Outcome(1));
        Assert.Equal(new AllowOutcome(false, "The policy tool ended with code 2, so the bar cannot tell whether the policy changed. An administrator can check it with RpaPolicy.exe show.", NoticeTone.Check),
            NextSteps.Outcome(2));
        Assert.Equal("The administrator prompt was cancelled, so the policy tool did not start.", NextSteps.Cancelled);
        Assert.Equal("The policy tool did not start: The file is not there.", NextSteps.NotStarted("The file is not there."));
    }

    [Fact]
    public void The_bar_opens_at_the_top_right_and_fits_a_small_screen()
    {
        var area = new Rectangle(0, 0, 1024, 728);
        Assert.Equal(new Rectangle(596, 8, 420, 600), BarLayout.Initial(area, new Size(420, 600), 8));
        // At 150 % on the same screen: as high as the screen allows.
        Assert.Equal(new Rectangle(382, 12, 630, 704), BarLayout.Initial(area, new Size(630, 900), 12));
        var wide = new Rectangle(0, 0, 1920, 1040);
        Assert.Equal(new Rectangle(1492, 8, 420, 600), BarLayout.Initial(wide, new Size(420, 600), 8));
        // A second screen to the left of the first.
        Assert.Equal(new Rectangle(-428, 8, 420, 600), BarLayout.Initial(new Rectangle(-1920, 0, 1920, 1040), new Size(420, 600), 8));
    }

    [Fact]
    public void On_a_screen_narrower_than_1280_the_bar_starts_narrower()
    {
        Assert.Equal(360, BarLayout.WidthFor(1024));
        Assert.Equal(360, BarLayout.WidthFor(1279));
        Assert.Equal(420, BarLayout.WidthFor(1280));
        Assert.Equal(420, BarLayout.WidthFor(1920));
        Assert.Equal(BarLayout.MinWidth, BarLayout.WidthFor(800));
    }

    [Fact]
    public void The_bar_grows_downward_so_that_the_list_keeps_its_rows()
    {
        var area = new Rectangle(0, 0, 1920, 1040);
        var bar = new Rectangle(1492, 8, 420, 600);
        // The list is 100 high and needs 160: the bar grows by 60.
        Assert.Equal(new Rectangle(1492, 8, 420, 660), BarLayout.GrowForList(bar, 100, 160, area));
        // High enough already: nothing changes, and the bar never shrinks for it.
        Assert.Equal(bar, BarLayout.GrowForList(bar, 200, 160, area));
        // Down to the bottom of the working area, then up: at most as high as the working area.
        Assert.Equal(new Rectangle(1492, 0, 420, 728), BarLayout.GrowForList(bar, 100, 400, new Rectangle(0, 0, 1024, 728)));
        Assert.Equal(new Rectangle(1492, 8, 420, 720), BarLayout.GrowForList(bar, 100, 220, new Rectangle(0, 0, 1024, 728)));
        // A bar the person moved down (and made shorter) goes up as far as it must, so that the list does not vanish.
        Assert.Equal(new Rectangle(8, 14, 360, 714), BarLayout.GrowForList(new Rectangle(8, 176, 360, 544), 0, 170, new Rectangle(0, 0, 1024, 728)));
        Assert.Equal(new Rectangle(0, 68, 420, 660), BarLayout.GrowForList(new Rectangle(0, 500, 420, 600), 100, 160, new Rectangle(0, 0, 1024, 728)));
        // Higher than the working area already: never smaller, and its top at the top.
        Assert.Equal(new Rectangle(0, 0, 420, 800), BarLayout.GrowForList(new Rectangle(0, 50, 420, 800), 100, 160, new Rectangle(0, 0, 1024, 728)));
        // A second screen above the first.
        Assert.Equal(new Rectangle(1492, -1000, 420, 660), BarLayout.GrowForList(new Rectangle(1492, -1000, 420, 600), 100, 160, new Rectangle(0, -1040, 1920, 1040)));
    }

    [Fact]
    public void The_list_is_grown_for_six_real_rows_wherever_it_is_scrolled()
    {
        // One-line rows of 27: six of them.
        Assert.Equal(162, StepRows.ListHeight([27, 27, 27, 27, 27, 27, 27, 27], 6, 27));
        // Rows that wrap count as high as they are: the six highest in a row.
        Assert.Equal(27 * 4 + 46 * 2, StepRows.ListHeight([27, 46, 27, 27, 27, 27, 46, 27, 27, 27], 6, 27));
        Assert.Equal(46 * 6, StepRows.ListHeight([46, 46, 46, 46, 46, 46, 46], 6, 27));
        // Fewer steps than rows: the steps, and one-line rows for the rest.
        Assert.Equal(46 + 27 * 5, StepRows.ListHeight([46], 6, 27));
        Assert.Equal(27 * 6, StepRows.ListHeight([], 6, 27));
        Assert.Equal(0, StepRows.ListHeight([46, 27], 0, 27));
    }

    [Fact]
    public void A_dialog_opens_beside_the_bar_so_that_the_list_stays_in_view()
    {
        var area = new Rectangle(0, 0, 1024, 728);
        var bar = new Rectangle(596, 8, 420, 600);
        Assert.Equal(new Point(168, 8), BarLayout.Beside(bar, new Size(420, 260), area, 8));
        // The bar dragged to the left edge: the dialog goes to its right.
        Assert.Equal(new Point(436, 8), BarLayout.Beside(new Rectangle(8, 8, 420, 600), new Size(420, 260), area, 8));
        // No room on either side: over the bar, inside the screen.
        Assert.Equal(new Point(0, 8), BarLayout.Beside(new Rectangle(300, 8, 420, 600), new Size(500, 260), area, 8));
        // The bar low on the screen: the dialog stays inside it.
        Assert.Equal(new Point(168, 468), BarLayout.Beside(new Rectangle(596, 600, 420, 120), new Size(420, 260), area, 8));
    }

    [Fact]
    public void A_field_whose_value_could_not_be_read_is_named_in_a_notice()
    {
        Assert.Equal("The value typed into \"Notes\" could not be read, so that step is not in the recording: add it by hand.", Notices.NotRead("Notes"));
    }
}
