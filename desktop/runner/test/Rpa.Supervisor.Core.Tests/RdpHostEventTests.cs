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
            new RdpHostEvent.Dialog("Remote Desktop Connection: An authentication error has occurred."),
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
        Assert.Equal("dialog Some text", new RdpHostEvent.Dialog("Some text").ToLine());
        Assert.Equal("alive", new RdpHostEvent.Alive().ToLine());
    }

    [Fact]
    public void Line_breaks_and_control_characters_in_a_text_become_spaces_and_a_long_text_is_cut()
    {
        Assert.Equal("dialog first line  second line", new RdpHostEvent.Dialog("first line\r\nsecond\tline").ToLine());
        Assert.Equal(RdpHostEvent.MaxText, ((RdpHostEvent.Dialog)RdpHostEvent.Parse(new RdpHostEvent.Dialog(new string('x', 2000)).ToLine())!).Text.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("active")]
    [InlineData("active x")]
    [InlineData("active -1")]
    [InlineData("disconnected 2055")]
    [InlineData("disconnected a b")]
    [InlineData("connected 3")]
    [InlineData("Unhandled exception. System.Exception")]
    public void Anything_else_is_not_an_event(string line)
    {
        Assert.Null(RdpHostEvent.Parse(line));
    }
}

public sealed class RdpFailuresTests
{
    private const string Bot = "rpabot";

    [Fact]
    public void Reason_2055_is_a_wrong_password()
    {
        var e = RdpFailures.FromDisconnect(Bot, 2055, 0, "Your credentials did not work.", null);

        Assert.Equal(SessionFailure.WrongPassword, e.Reason);
        Assert.Equal("Windows refused the password of rpabot (Remote Desktop disconnect reason 2055: Your credentials did not work.).", e.Message);
    }

    [Theory]
    [InlineData(3847)]
    [InlineData(4615)]
    public void An_expired_password_or_one_that_must_change_is_PasswordExpired(int reason)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, 0, "", null);

        Assert.Equal(SessionFailure.PasswordExpired, e.Reason);
        Assert.Equal($"The password of rpabot has expired or must be changed (Remote Desktop disconnect reason {reason}). Set a new one and store it for the RPA Supervisor again.", e.Message);
    }

    [Fact]
    public void Extended_reason_9_is_NotAllowed()
    {
        var e = RdpFailures.FromDisconnect(Bot, 3, 9, "", null);

        Assert.Equal(SessionFailure.NotAllowed, e.Reason);
        Assert.Equal("rpabot may not sign in through Remote Desktop; it needs to be in the Remote Desktop Users group (Remote Desktop disconnect reason 3, extended reason 9).", e.Message);
    }

    // The client's security layer (Network Level Authentication) reports its failures with reasons whose low byte is 7:
    // a disabled, locked or expired account, an unknown user, a logon restriction, and 519, which a client in the
    // service's session gives when the domain is empty. Any of them may concern the password; retrying could lock the
    // account, so none is retried.
    [Theory]
    [InlineData(519)]
    [InlineData(2567)]
    [InlineData(2823)]
    [InlineData(3079)]
    [InlineData(3335)]
    [InlineData(3591)]
    [InlineData(1799)]
    public void Any_other_failure_of_the_security_layer_counts_as_a_wrong_password(int reason)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, 0, "", null);

        Assert.Equal(SessionFailure.WrongPassword, e.Reason);
        Assert.Equal($"The Remote Desktop sign-in of rpabot failed in the client's security layer (Remote Desktop disconnect reason {reason}, extended reason 0). It may be a password or account problem, so it is treated as a refused password.", e.Message);
    }

    [Fact]
    public void Fresh_credentials_required_by_the_server_counts_as_a_wrong_password()
    {
        Assert.Equal(SessionFailure.WrongPassword, RdpFailures.FromDisconnect(Bot, 3, 10, "", null).Reason);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(3, 5)]
    [InlineData(264, 0)]
    [InlineData(516, 0)]
    [InlineData(2825, 0)]
    [InlineData(3, 4)]
    public void Anything_else_is_HostExited_with_the_numbers_in_the_message(int reason, int extended)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, extended, "Some description.", null);

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.Equal($"The Remote Desktop connection for rpabot ended before the session was ready (Remote Desktop disconnect reason {reason}, extended reason {extended}: Some description.).", e.Message);
    }

    [Fact]
    public void A_dialog_the_client_showed_is_named_in_the_message()
    {
        var e = RdpFailures.FromDisconnect(Bot, 264, 0, "", "Remote Desktop Connection: The connection timed out.");

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.EndsWith(" The Remote Desktop client showed: \"Remote Desktop Connection: The connection timed out.\".", e.Message);
    }

    [Fact]
    public void An_attempt_that_ends_without_a_disconnect_keeps_its_reason()
    {
        var e = RdpFailures.WithoutDisconnect(SessionFailure.Timeout, "rpabot was not signed in within 25 s.", null);

        Assert.Equal(SessionFailure.Timeout, e.Reason);
        Assert.Equal("rpabot was not signed in within 25 s.", e.Message);
    }

    [Theory]
    [InlineData(SessionFailure.Timeout)]
    [InlineData(SessionFailure.HostExited)]
    public void An_attempt_that_ends_without_a_disconnect_after_a_dialog_counts_as_a_wrong_password(SessionFailure reason)
    {
        // The dialog may have been about the password, and nothing says otherwise.
        var e = RdpFailures.WithoutDisconnect(reason, "rpabot was not signed in within 25 s.", "Your credentials did not work");

        Assert.Equal(SessionFailure.WrongPassword, e.Reason);
        Assert.Equal("rpabot was not signed in within 25 s. The Remote Desktop client showed: \"Your credentials did not work\". It may be a password problem, so it is treated as a refused password.", e.Message);
    }
}
