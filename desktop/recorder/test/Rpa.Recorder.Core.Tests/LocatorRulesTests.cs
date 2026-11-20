using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

public class LocatorRulesTests
{
    private static readonly ElementFacts MainForm = El("Window", "MainForm", "ERP Demo - Line items", WinFormsClass);
    private static readonly ElementFacts Grid = El("DataGrid", "gridResults", "Results", WinFormsClass, false, false, MainForm);

    [Fact]
    public void A_locator_is_type_plus_stable_id_plus_name_when_both_exist()
    {
        var target = LocatorRules.Target(Window, El("Edit", "txtUser", "User name", "", false, false, MainForm), 1);
        Assert.Equal(new RecordedCondition("Edit", "txtUser", "User name"), Assert.Single(target.Path));
        Assert.Equal(new RecordedCondition("Button", "1", null), LocatorRules.Condition(El("Button", "1", "")));
        Assert.Equal(new RecordedCondition("MenuItem", null, "File"), LocatorRules.Condition(El("MenuItem", "", "File")));
    }

    [Fact]
    public void A_generated_id_is_left_out_and_the_element_is_found_by_type_and_name()
    {
        Assert.Equal(new RecordedCondition("DataItem", null, "Acme Paper Co"), LocatorRules.Condition(El("DataItem", "4237251161", "Acme Paper Co")));
        Assert.Equal(new RecordedCondition("Pane", null, "Detail"), LocatorRules.Condition(El("Pane", "3f2a9c1e-77b0-4c1d-9a55-0123456789ab", "Detail")));
    }

    [Fact]
    public void A_locator_never_has_an_index_and_a_text_the_importer_would_refuse_is_left_out()
    {
        Assert.Equal(["ControlType", "AutomationId", "Name"], typeof(RecordedCondition).GetProperties().Where(p => p.DeclaringType == typeof(RecordedCondition) && p.Name != "EqualityContract").Select(p => p.Name));
        Assert.Equal(new RecordedCondition("Text", "lblNote", null), LocatorRules.Condition(El("Text", "lblNote", "two\nlines")));
        Assert.Equal(new RecordedCondition("Text", "lblNote", null), LocatorRules.Condition(El("Text", "lblNote", new string('x', 501))));
        Assert.Equal(new RecordedCondition("Text", "lblNote", null), LocatorRules.Condition(El("Text", "lblNote", "{{$exportDir}}")));
        Assert.Equal(new RecordedCondition("Text", "lblNote", null), LocatorRules.Condition(El("Text", "lblNote", "  ")));
        Assert.Equal(new RecordedCondition("Text", "lblNote", new string('x', 500)), LocatorRules.Condition(El("Text", "lblNote", new string('x', 500))));
    }

    [Fact]
    public void An_element_whose_Matches_is_not_1_is_found_under_its_nearest_ancestor_with_a_stable_id()
    {
        var cell = El("DataItem", "", "Acme Paper Co", "", false, false, El("Unknown", "", "Row 1"), Grid, MainForm);
        Assert.Equal([new RecordedCondition("DataGrid", "gridResults", null), new RecordedCondition("DataItem", null, "Acme Paper Co")],
            LocatorRules.Target(Window, cell, 3).Path);
        Assert.Single(LocatorRules.Target(Window, cell, 1).Path);
        // No ancestor with a stable id below the window: recorded with what there is.
        var lone = El("Button", "", "OK", "", false, false, El("Pane", "", ""), MainForm);
        Assert.Equal([new RecordedCondition("Button", null, "OK")], LocatorRules.Target(Window, lone, 2).Path);
    }

    [Fact]
    public void An_element_whose_name_carries_a_position_is_flagged_positional()
    {
        var cell = El("DataItem", "4237251161", "Vendor Row 1", "", false, false, El("Unknown", "", "Row 1"), Grid, MainForm);
        Assert.True(LocatorRules.IsPositional(LocatorRules.Target(Window, cell, 1)));
        Assert.True(LocatorRules.IsPositional(LocatorRules.Target(Window, cell, 2)));
        Assert.False(LocatorRules.IsPositional(LocatorRules.Target(Window, El("DataItem", "", "Acme Paper Co", "", false, false, Grid), 1)));
        Assert.False(LocatorRules.IsPositional(LocatorRules.Target(Window, El("Button", "btnRow1", "Row 1"), 1)));
    }

    [Fact]
    public void A_WinForms_window_is_found_by_its_title_and_a_Win32_one_by_its_class()
    {
        Assert.Equal(new RecordedWindow("erpdemo.exe", "ERP Demo - Sign in", null), WindowRules.Window(new("erpdemo.exe", "ERP Demo - Sign in", WinFormsClass)));
        Assert.Equal(new RecordedWindow("notepad.exe", null, "Notepad"), WindowRules.Window(new("notepad.exe", "*Untitled - Notepad", "Notepad")));
        Assert.Equal(new RecordedWindow("notepad.exe", null, "Notepad"), WindowRules.Window(new("notepad.exe", "Untitled - Notepad", "Notepad")));
    }

    [Fact]
    public void A_WPF_window_is_found_by_its_title_and_a_window_with_a_generated_class_and_no_title_by_its_exe()
    {
        Assert.Equal(new RecordedWindow("app.exe", "Orders", null), WindowRules.Window(new("app.exe", "Orders", "HwndWrapper[App;;3f2a9c1e-77b0-4c1d-9a55-0123456789ab]")));
        Assert.Equal(new RecordedWindow("erpdemo.exe", null, null), WindowRules.Window(new("erpdemo.exe", "", "WindowsForms10.Window.808.app.0.19fd5c7_r3_ad1")));
        Assert.Equal(new RecordedWindow("app.exe", "Main", null), WindowRules.Window(new("app.exe", "Main", "Afx:00400000:b:00010003:00000006:00000000")));
    }

    [Fact]
    public void A_system_dialog_or_menu_window_is_found_by_its_title_and_class()
    {
        Assert.Equal(new RecordedWindow("erpdemo.exe", "Export line items", "#32770"), WindowRules.Window(new("erpdemo.exe", "Export line items", "#32770")));
        Assert.Equal(new RecordedWindow("notepad.exe", null, "#32768"), WindowRules.Window(new("notepad.exe", "", "#32768")));
    }

    [Fact]
    public void A_window_text_the_importer_would_refuse_is_left_out()
    {
        Assert.Equal(new RecordedWindow(null, "Orders", null), WindowRules.Window(new(@"C:\Apps\app.exe", "Orders", WinFormsClass)));
        Assert.Equal(new RecordedWindow("app.exe", null, null), WindowRules.Window(new("app.exe", "{{$exportDir}}", WinFormsClass)));
    }
}
