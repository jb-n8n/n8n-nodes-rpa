using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>What the first run on a real machine asked for: the command line the recorder starts a program with, a
/// read step that does not depend on the text it reads, and the windows "Record an open window..." offers.</summary>
public class LaunchAndReadTests
{
    [Fact]
    public void The_command_line_quotes_the_program_and_each_argument_as_Windows_reads_them()
    {
        Assert.Equal("\"C:\\Program Files\\ERP Demo\\ErpDemo.exe\"", CommandLine.Join(@"C:\Program Files\ERP Demo\ErpDemo.exe", []));
        Assert.Equal("\"C:\\Apps\\app.exe\" --ui v2", CommandLine.Join(@"C:\Apps\app.exe", ["--ui", "v2"]));
        Assert.Equal("\"C:\\Apps\\app.exe\" \"two words\" \"\"", CommandLine.Join(@"C:\Apps\app.exe", ["two words", ""]));
        Assert.Equal("\"C:\\Apps\\app.exe\" \"say \\\"hi\\\"\"", CommandLine.Join(@"C:\Apps\app.exe", ["say \"hi\""]));
        // Backslashes are doubled only before a quote, including the closing one.
        Assert.Equal("\"C:\\Apps\\app.exe\" C:\\data\\ \"C:\\my data\\\\\"", CommandLine.Join(@"C:\Apps\app.exe", [@"C:\data\", @"C:\my data\"]));
        Assert.Equal("\"C:\\Apps\\app.exe\" \"a\\\\\\\"b\"", CommandLine.Join(@"C:\Apps\app.exe", ["a\\\"b"]));
        Assert.Throws<ArgumentException>(() => CommandLine.Join("C:\\Apps\\a\"pp.exe", []));
    }

    [Fact]
    public void A_read_step_finds_its_element_by_its_stable_id_without_the_text_it_reads()
    {
        var count = El("Text", "lblResultCount", "6 line items");
        var s = Record(Click(1, El("Button", "btnOk", "OK")));
        s.AddRead(count, Window, "out_ResultCount");
        var read = s.Steps[^1];
        Assert.Equal([new RecordedCondition("Text", "lblResultCount", null)], read.Target!.Path);
        Assert.Equal("Read lblResultCount as out_ResultCount", StepText.Sentence(read));
        Assert.Equal("out_result_count", StepText.SuggestedReadName(count));
        Assert.DoesNotContain("6 line items", s.ToFile("Test").ToJson());
    }

    [Fact]
    public void A_read_step_with_no_stable_id_keeps_the_text_and_is_marked_for_the_person_to_check()
    {
        var cell = El("DataItem", "4237251161", "Acme Paper Co");
        var s = Record(Click(1, El("Button", "btnOk", "OK")));
        s.AddRead(cell, Window, "out_Vendor");
        var read = s.Steps[^1];
        Assert.Equal([new RecordedCondition("DataItem", null, "Acme Paper Co")], read.Target!.Path);
        Assert.True(read.FoundByText);
        Assert.Equal("Read DataItem as out_Vendor (found by the text it shows now: check it)", StepText.Sentence(read));
        Assert.Equal("out_data_item", StepText.SuggestedReadName(cell));
    }

    [Fact]
    public void Record_an_open_window_offers_only_windows_a_person_can_mean()
    {
        Assert.True(OpenWindows.IsOffered("ERP Demo - Sign in", "WindowsForms10.Window.8.app.0.19fd5c7_r3_ad1", cloaked: false, own: false));
        Assert.True(OpenWindows.IsOffered("Untitled - Notepad", "Notepad", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("Program Manager", "Progman", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("", "WorkerW", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("Taskbar", "Shell_TrayWnd", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("Taskbar", "Shell_SecondaryTrayWnd", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("Windows Input Experience", "Windows.UI.Core.CoreWindow", cloaked: true, own: false));
        Assert.False(OpenWindows.IsOffered("   ", "Notepad", cloaked: false, own: false));
        Assert.False(OpenWindows.IsOffered("RPA Recorder", "WindowsForms10.Window.8.app.0.1", cloaked: false, own: true));
    }
}
