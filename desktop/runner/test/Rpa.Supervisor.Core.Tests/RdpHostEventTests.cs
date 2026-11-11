namespace Rpa.Supervisor.Core.Tests;

public sealed class RdpHostEventTests
{
    [Fact]
    public void Each_event_is_one_line_and_reads_back_the_same()
    {
        RdpHostEvent[] events =
        [
            new RdpHostEvent.Active(7),
            new RdpHostEvent.Disconnected(2055, 0, ""),
            new RdpHostEvent.Disconnected(3, 9, "The connection was denied because the user account is not authorized for remote login."),
            new RdpHostEvent.Dialog(true, "Remote Desktop Connection: An authentication error has occurred."),
            new RdpHostEvent.Dialog(false, "Remote Desktop Connection"),
            new RdpHostEvent.LogonError(1),
            new RdpHostEvent.Warning(-3),
            new RdpHostEvent.Failed("The RDP client control could not be created."),
            new RdpHostEvent.Alive(),
        ];

        foreach (var e in events)
        {
            var line = e.ToLine();
            Assert.DoesNotContain('\n', line);
            Assert.Equal(e, RdpHostEvent.Parse(line));
        }
    }

    [Fact]
    public void The_lines_are_the_documented_ones()
    {
        Assert.Equal("active 7", new RdpHostEvent.Active(7).ToLine());
        Assert.Equal("disconnected 2055 0", new RdpHostEvent.Disconnected(2055, 0, "").ToLine());
        Assert.Equal("disconnected 3 9 Not allowed.", new RdpHostEvent.Disconnected(3, 9, "Not allowed.").ToLine());
        Assert.Equal("dialog button Some text", new RdpHostEvent.Dialog(true, "Some text").ToLine());
        Assert.Equal("dialog closed Some text", new RdpHostEvent.Dialog(false, "Some text").ToLine());
        Assert.Equal("logon-error 1", new RdpHostEvent.LogonError(1).ToLine());
        Assert.Equal("warning 1", new RdpHostEvent.Warning(1).ToLine());
        Assert.Equal("alive", new RdpHostEvent.Alive().ToLine());
    }

    [Fact]
    public void Line_breaks_and_control_characters_in_a_text_become_spaces_and_a_long_text_is_cut()
    {
        Assert.Equal("dialog button first line  second line", new RdpHostEvent.Dialog(true, "first line\r\nsecond\tline").ToLine());
        var cut = (RdpHostEvent.Dialog)RdpHostEvent.Parse(new RdpHostEvent.Dialog(true, new string('x', 2000)).ToLine())!;
        Assert.Equal(RdpHostEvent.MaxText, cut.Text.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("active")]
    [InlineData("active x")]
    [InlineData("active -1")]
    [InlineData("disconnected 2055")]
    [InlineData("disconnected a b")]
    [InlineData("dialog Some text")]
    [InlineData("logon-error x")]
    [InlineData("warning")]
    [InlineData("connected 3")]
    [InlineData("Unhandled exception. System.Exception")]
    public void Anything_else_is_not_an_event(string line)
    {
        Assert.Null(RdpHostEvent.Parse(line));
    }
}
