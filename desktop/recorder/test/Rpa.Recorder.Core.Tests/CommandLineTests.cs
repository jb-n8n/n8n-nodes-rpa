namespace Rpa.Recorder.Core.Tests;

/// <summary>The command line the recorder starts a program with, and the arguments box split as Windows reads it.</summary>
public class CommandLineTests
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
    public void The_arguments_box_is_split_as_Windows_reads_a_command_line()
    {
        Assert.Equal(["--ui", "v2", @"C:\My Files\a.txt", "say \"hi\"", ""], CommandLine.Split("--ui v2 \"C:\\My Files\\a.txt\" \"say \\\"hi\\\"\" \"\""));
        Assert.Equal([@"C:\data\", "x"], CommandLine.Split(@"  C:\data\   x "));
        Assert.Empty(CommandLine.Split("   "));
        foreach (var args in new[] { new[] { "a b", "", "c\\", "d\\\"e", "\"", "f\\\\ g\\" }, ["plain"], [] })
            Assert.Equal(args, CommandLine.Split(CommandLine.JoinArguments(args)));
    }
}
