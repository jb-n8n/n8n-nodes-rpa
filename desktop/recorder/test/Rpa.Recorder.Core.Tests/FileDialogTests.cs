using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>A Save dialog accepted with the name it offers gives the export step a typed name gives.</summary>
public class FileDialogTests
{
    private static readonly WindowFacts SaveAs = new("app.exe", "Save As", "#32770");
    private static readonly ElementFacts Dialog = El("Window", "", "Save As", "#32770");
    private static readonly ElementFacts NameBox = El("Edit", "1001", "File name:", "Edit", false, false,
        El("ComboBox", "FileNameControlHost", "File name:", "AppControlHost"), El("Pane", "", "", "DUIViewWndClassName"), Dialog);
    private static readonly ElementFacts SaveButton = El("Button", "1", "Save", "Button", false, false, Dialog);
    private static readonly ElementFacts CancelButton = El("Button", "2", "Cancel", "Button", false, false, Dialog);
    private static readonly ElementFacts FolderList = El("List", "", "Items View", "", false, false, El("Pane", "", "Shell Folder View"), Dialog);
    private static readonly ElementFacts Export = El("MenuItem", "", "Export...");

    // An Open dialog: its name box is a combo box with control id 1148 holding an Edit 1148; its default button is Open.
    private static readonly WindowFacts OpenWindow = new("app.exe", "Open", "#32770");
    private static readonly ElementFacts OpenDialog = El("Window", "", "Open", "#32770");
    private static readonly ElementFacts OpenNameBox = El("Edit", "1148", "File name:", "Edit", false, false,
        El("ComboBox", "1148", "File name:", "ComboBox"), OpenDialog);
    private static readonly ElementFacts OpenButton = El("Button", "1", "Open", "Button", false, false, OpenDialog);

    // The question Windows asks when the file is there already: a task dialog, its Yes CommandButton_6, its No CommandButton_7.
    private static readonly WindowFacts ConfirmSaveAs = new("app.exe", "Confirm Save As", "#32770");
    private static readonly ElementFacts Confirm = El("Window", "", "Confirm Save As", "#32770");
    private static readonly ElementFacts Yes = El("Button", "CommandButton_6", "Yes", "CCPushButton", false, false, El("Pane", "", "", "DirectUIHWND"), Confirm);
    private static readonly ElementFacts No = El("Button", "CommandButton_7", "No", "CCPushButton", false, false, El("Pane", "", "", "DirectUIHWND"), Confirm);
    private static readonly ElementFacts Post = El("Button", "btnPost", "Post");

    private static FileDialogAccepted Accepted(int second, string? value, ElementFacts? box = null, WindowFacts? window = null) =>
        new(At(second), window ?? SaveAs, box ?? NameBox, value);

    [Fact]
    public void The_offered_name_accepted_by_a_click_on_Save_is_saved_into_the_export_folder()
    {
        var s = Record(Click(1, Export), Accepted(2, "report"), Click(2, SaveButton, window: SaveAs));
        Assert.Equal(["Click Export...", "Save report into the run's export folder", "Click Save"], s.Steps.Select(x => StepText.Action(x)));
        var export = s.Steps[1];
        Assert.Equal((StepKind.Fill, "{{$exportDir}}\\report", "report"), (export.Kind, export.Value, export.ExportFile));
        Assert.Equal(new RecordedWindow("app.exe", "Save As", "#32770"), export.Target!.Window);
        Assert.Equal([new RecordedCondition("Edit", "1001", "File name:")], export.Target.Path);
        Assert.False(s.TakeSaveNotice());
        // Deleted like any other step.
        s.Delete(1);
        Assert.Equal(["Click Export...", "Click Save"], s.Steps.Select(x => StepText.Action(x)));
    }

    [Fact]
    public void The_offered_name_accepted_by_Enter_or_Space_is_saved_into_the_export_folder()
    {
        var s = Record(Accepted(1, "line-items.csv"), Key(1, NameBox, "Enter", SaveAs));
        Assert.Equal(["Save line-items.csv into the run's export folder", "Press Enter in File name:"], s.Steps.Select(x => StepText.Action(x)));
        s = Record(Accepted(1, "line-items"), Key(1, SaveButton, "Enter", SaveAs));
        Assert.Equal(["Save line-items into the run's export folder", "Press Enter in Save"], s.Steps.Select(x => StepText.Action(x)));
        s = Record(Accepted(1, "line-items"), new Activated(At(1), SaveAs, SaveButton));
        Assert.Equal(["Save line-items into the run's export folder", "Click Save"], s.Steps.Select(x => StepText.Action(x)));
    }

    [Fact]
    public void Only_a_click_or_Space_on_the_default_button_or_Enter_in_the_name_box_or_on_that_button_accepts_the_dialog()
    {
        Assert.Equal(SaveAs, FileDialogs.AcceptedDialog(Click(1, SaveButton, window: SaveAs)));
        Assert.Equal(SaveAs, FileDialogs.AcceptedDialog(new Activated(At(1), SaveAs, SaveButton)));
        Assert.Equal(SaveAs, FileDialogs.AcceptedDialog(Key(1, NameBox, "Enter", SaveAs)));
        Assert.Equal(SaveAs, FileDialogs.AcceptedDialog(Key(1, SaveButton, "Enter", SaveAs)));

        Assert.Null(FileDialogs.AcceptedDialog(Click(1, CancelButton, window: SaveAs)));
        Assert.Null(FileDialogs.AcceptedDialog(Click(1, NameBox, window: SaveAs)));
        Assert.Null(FileDialogs.AcceptedDialog(Key(1, FolderList, "Enter", SaveAs)));
        Assert.Null(FileDialogs.AcceptedDialog(Key(1, CancelButton, "Enter", SaveAs)));
        Assert.Null(FileDialogs.AcceptedDialog(Key(1, NameBox, "Tab", SaveAs)));
        Assert.Null(FileDialogs.AcceptedDialog(Typed(1, NameBox, SaveAs)));
        // A button 1 in an app's own window is not a dialog's default button.
        Assert.Null(FileDialogs.AcceptedDialog(Click(1, El("Button", "1", "Save"))));
    }

    [Fact]
    public void A_typed_name_then_accepted_gives_one_export_step()
    {
        var s = Record(Click(1, NameBox, window: SaveAs), Typed(2, NameBox, SaveAs), Left(3, NameBox, "report.csv", window: SaveAs));
        Assert.False(s.ReadsNameBox(SaveAs, NameBox));
        // The Windows layer does not read it then; a value given all the same is not used.
        s.Add(Accepted(3, "report.csv"));
        s.Add(Click(3, SaveButton, window: SaveAs));
        Assert.Equal(["Save report.csv into the run's export folder", "Click Save"], s.Steps.Select(x => StepText.Action(x)));
        Assert.Single(s.Steps, x => x.ExportFile is not null);
        Assert.False(s.TakeSaveNotice());

        // The next Save dialog, accepted with the name it offers, gets its own step.
        Assert.True(s.ReadsNameBox(SaveAs, NameBox));
        s.Add(Accepted(5, "report.csv"));
        s.Add(Click(5, SaveButton, window: SaveAs));
        Assert.Equal(2, s.Steps.Count(x => x.ExportFile == "report.csv"));
    }

    [Fact]
    public void A_typed_path_still_gives_the_steps_it_gave_before()
    {
        var typed = Record(Click(1, NameBox, window: SaveAs), Typed(2, NameBox, SaveAs), Left(3, NameBox, @"C:\out\report.csv", window: SaveAs),
            Click(3, SaveButton, window: SaveAs));
        var accepted = Record(Click(1, NameBox, window: SaveAs), Typed(2, NameBox, SaveAs), Left(3, NameBox, @"C:\out\report.csv", window: SaveAs),
            Accepted(3, null), Click(3, SaveButton, window: SaveAs));
        Assert.Equal(typed.ToFile("Test").ToJson(), accepted.ToFile("Test").ToJson());
        Assert.False(accepted.TakeSaveNotice());
    }

    [Fact]
    public void An_Open_dialog_gives_no_export_step()
    {
        Assert.False(FileDialogs.IsFileNameBox(OpenWindow, OpenNameBox));
        Assert.False(new Session().ReadsNameBox(OpenWindow, OpenNameBox));
        // Even if its name box were reported, nothing is made of it, and nothing is said.
        var s = Record(Accepted(1, "report.csv", OpenNameBox, OpenWindow), Click(1, OpenButton, window: OpenWindow));
        Assert.Equal(["Click Open"], s.Steps.Select(x => StepText.Action(x)));
        Assert.False(s.TakeSaveNotice());
        // Another dialog's control 1001 is an ordinary field.
        var customer = El("Edit", "1001", "Company", "Edit", false, false, El("Pane", "", ""), El("Window", "", "Customer", "#32770"));
        Assert.False(new Session().ReadsNameBox(new("app.exe", "Customer", "#32770"), customer));
    }

    [Fact]
    public void A_path_an_empty_box_or_a_name_a_step_cannot_type_gives_no_step_and_one_notice()
    {
        foreach (var value in new[] { @"C:\out\report.csv", "out/report.csv", "", "a*b", "{{var.x}}", null })
        {
            var s = Record(Accepted(1, value), Click(1, SaveButton, window: SaveAs));
            Assert.Equal(["Click Save"], s.Steps.Select(x => StepText.Action(x)));
            Assert.True(s.TakeSaveNotice(), value);
            Assert.False(s.TakeSaveNotice());
        }
        // One notice in a recording: a second such Save says nothing more.
        var twice = Record(Accepted(1, ""), Click(1, SaveButton, window: SaveAs));
        Assert.True(twice.TakeSaveNotice());
        twice.Add(Accepted(2, @"C:\out\a.csv"));
        Assert.False(twice.TakeSaveNotice());
        Assert.Equal(
            "This Save keeps the app's own folder, so the file does not come back to n8n. To get it back, type a file name in the Save dialog.",
            Notices.SaveKeepsFolder);
    }

    [Fact]
    public void A_name_box_that_may_be_a_password_box_is_never_used()
    {
        var flagged = NameBox with { IsPassword = true };
        var s = Record(Accepted(1, "report.csv", flagged), Click(1, SaveButton, window: SaveAs));
        Assert.Equal(["Click Save"], s.Steps.Select(x => StepText.Action(x)));
        Assert.DoesNotContain("report.csv", s.ToFile("Test").ToJson());
    }

    [Fact]
    public void Yes_to_replacing_the_file_after_a_Save_into_the_export_folder_is_left_out_and_said()
    {
        // The person saved over a file that was there; a run saves into a new folder of its own, where Windows never asks.
        var s = Record(Click(1, Export), Accepted(2, "report.csv"), Click(2, SaveButton, window: SaveAs), Click(3, Yes, window: ConfirmSaveAs), Click(5, Post));
        Assert.Equal(["Click Export...", "Save report.csv into the run's export folder", "Click Save", "Click Post"], s.Steps.Select(x => StepText.Action(x)));
        Assert.DoesNotContain("Confirm Save As", s.ToFile("Test").ToJson());
        Assert.True(s.TakeOverwriteNotice());
        Assert.False(s.TakeOverwriteNotice());
        Assert.Equal("Yes to replacing the file is not a step: a run saves into a new folder of its own, where the file is not there yet.", Notices.OverwriteLeftOut);

        // A typed name, and keys that move to Yes; Yes by Enter or by Space.
        var typed = Record(Click(1, NameBox, window: SaveAs), Typed(2, NameBox, SaveAs), Left(3, NameBox, "report.csv", window: SaveAs), Accepted(3, null),
            Click(3, SaveButton, window: SaveAs), Key(4, No, "Shift+Tab", ConfirmSaveAs), Key(4, Yes, "Left", ConfirmSaveAs), Click(4, Yes, window: ConfirmSaveAs));
        Assert.Equal(["Save report.csv into the run's export folder", "Click Save"], typed.Steps.Select(x => StepText.Action(x)));
        Assert.True(typed.TakeOverwriteNotice());
        foreach (var answer in new Observation[]
                 {
                     Key(4, Yes, "Enter", ConfirmSaveAs), new Activated(At(4), ConfirmSaveAs, Yes),
                 })
        {
            var by = Record(Accepted(1, "report.csv"), Key(1, NameBox, "Enter", SaveAs), answer);
            Assert.Equal(["Save report.csv into the run's export folder", "Press Enter in File name:"], by.Steps.Select(x => StepText.Action(x)));
            Assert.True(by.TakeOverwriteNotice());
        }
    }

    [Fact]
    public void Yes_to_replacing_the_file_stays_where_a_run_is_asked_too_or_where_it_is_not_that_answer()
    {
        // The same name saved earlier in the recording: a run saved it into its folder too, so Windows asks then.
        var again = Record(Accepted(1, "report.csv"), Click(1, SaveButton, window: SaveAs), Click(3, Post),
            Accepted(5, "REPORT.csv"), Click(5, SaveButton, window: SaveAs), Click(6, Yes, window: ConfirmSaveAs));
        Assert.Equal("Click Yes", StepText.Action(again.Steps[^1]));
        Assert.False(again.TakeOverwriteNotice());

        // No, a Save that keeps the app's folder (a run is asked as the person was), a step in between, a Yes with no
        // Save before it, and a message box's Yes: each is recorded as before.
        Observation[][] kept =
        [
            [Accepted(1, "report.csv"), Click(1, SaveButton, window: SaveAs), Click(2, No, window: ConfirmSaveAs)],
            [Accepted(1, @"C:\out\report.csv"), Click(1, SaveButton, window: SaveAs), Click(2, Yes, window: ConfirmSaveAs)],
            [Accepted(1, "report.csv"), Click(1, SaveButton, window: SaveAs), Click(2, Post), Click(3, Yes, window: ConfirmSaveAs)],
            [Click(1, Export), Click(2, Yes, window: ConfirmSaveAs)],
            // A message box's Yes (6) is the app's own question.
            [Accepted(1, "report.csv"), Click(1, SaveButton, window: SaveAs), Click(2, El("Button", "6", "Yes", "Button", false, false, Confirm), window: ConfirmSaveAs)],
        ];
        foreach (var observations in kept)
        {
            var s = Record(observations);
            Assert.Equal(StepKind.Click, s.Steps[^1].Kind);
            Assert.Equal(ConfirmSaveAs.Title, s.Steps[^1].Target!.Window.Title);
            Assert.False(s.TakeOverwriteNotice());
        }
    }

    [Fact]
    public void The_ERP_Demo_flow_with_the_offered_name_writes_the_engines_fixture()
    {
        // The engine imports recording-erp/erp-default-name.rpa-recording.json; the recorder writes exactly that file
        // when the person keeps the name the Save dialog offers.
        var golden = RepoFile("packages", "engine", "test", "fixtures", "import", "recording-erp", "erp-default-name.rpa-recording.json");
        var s = Record(ErpDemoObservations.DefaultName());
        Assert.Equal("Save line-items into the run's export folder", StepText.Action(s.Steps[^2]));
        Assert.Equal(golden.ReplaceLineEndings("\n").TrimEnd(), s.ToFile("ERP Demo line items").ToJson().ReplaceLineEndings("\n").TrimEnd());
    }
}
