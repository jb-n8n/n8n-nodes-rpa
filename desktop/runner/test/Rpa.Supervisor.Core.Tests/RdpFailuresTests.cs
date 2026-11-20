namespace Rpa.Supervisor.Core.Tests;

public sealed class RdpFailuresTests
{
    private const string Bot = "rpabot";
    private static readonly ClientReports None = ClientReports.None;

    [Fact]
    public void Reason_2055_is_a_wrong_password()
    {
        var e = RdpFailures.FromDisconnect(Bot, 2055, 0, "Your credentials did not work.", None);

        Assert.Equal(SessionFailure.WrongPassword, e.Reason);
        Assert.Equal("Windows refused the password of rpabot (Remote Desktop disconnect reason 2055, extended reason 0: Your credentials did not work.).", e.Message);
    }

    // An unknown user, a disabled account, a logon restriction, a locked account, an expired account: retrying could lock
    // the account or cannot help, so these stop the sign-ins as a refused password does.
    [Theory]
    [InlineData(2567)]
    [InlineData(2823)]
    [InlineData(3079)]
    [InlineData(3335)]
    [InlineData(3591)]
    public void The_listed_account_refusals_count_as_a_wrong_password(int reason)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, 0, "", None);

        Assert.Equal(SessionFailure.WrongPassword, e.Reason);
        Assert.Equal($"Windows refused the sign-in of rpabot because of its password or account (Remote Desktop disconnect reason {reason}, extended reason 0).", e.Message);
    }

    [Fact]
    public void Fresh_credentials_required_by_the_server_counts_as_a_wrong_password()
    {
        Assert.Equal(SessionFailure.WrongPassword, RdpFailures.FromDisconnect(Bot, 3, 10, "", None).Reason);
    }

    [Theory]
    [InlineData(3847)]
    [InlineData(4615)]
    public void An_expired_password_or_one_that_must_change_is_PasswordExpired(int reason)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, 0, "", None);

        Assert.Equal(SessionFailure.PasswordExpired, e.Reason);
        Assert.Equal($"The password of rpabot has expired or must be changed (Remote Desktop disconnect reason {reason}, extended reason 0). Set a new one and store it for the RPA Supervisor again.", e.Message);
    }

    [Fact]
    public void Extended_reason_9_is_NotAllowed()
    {
        var e = RdpFailures.FromDisconnect(Bot, 3, 9, "", None);

        Assert.Equal(SessionFailure.NotAllowed, e.Reason);
        Assert.Equal("rpabot may not sign in through Remote Desktop; it needs to be in the Remote Desktop Users group (Remote Desktop disconnect reason 3, extended reason 9).", e.Message);
    }

    // The client's security layer reports its failures with reasons whose low byte is 7. Those not known to concern the
    // password or the account fail the connection without a retry and without stopping later sign-ins.
    [Theory]
    [InlineData(519)]
    [InlineData(1799)]
    [InlineData(2311)]
    public void Any_other_failure_of_the_security_layer_is_Refused(int reason)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, 0, "", None);

        Assert.Equal(SessionFailure.Refused, e.Reason);
        Assert.Equal($"The Remote Desktop client refused the sign-in of rpabot (Remote Desktop disconnect reason {reason}, extended reason 0).", e.Message);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(3, 5)]
    [InlineData(264, 0)]
    [InlineData(516, 0)] // the Remote Desktop service is stopped: tried again
    [InlineData(2825, 0)]
    [InlineData(3, 4)]
    public void Anything_else_is_HostExited_with_the_numbers_in_the_message(int reason, int extended)
    {
        var e = RdpFailures.FromDisconnect(Bot, reason, extended, "Some description.", None);

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.Equal($"The Remote Desktop connection for rpabot ended before the session was ready (Remote Desktop disconnect reason {reason}, extended reason {extended}: Some description.).", e.Message);
    }

    [Fact]
    public void What_the_client_showed_and_reported_is_in_the_message()
    {
        var e = RdpFailures.FromDisconnect(Bot, 264, 0, "", new ClientReports("Remote Desktop Connection: The connection timed out.", 1, 3));

        Assert.Equal(SessionFailure.HostExited, e.Reason);
        Assert.EndsWith(" The Remote Desktop client showed: \"Remote Desktop Connection: The connection timed out.\". It reported logon error 1. It reported warning 3.", e.Message);
    }

    [Fact]
    public void An_attempt_that_ends_without_a_disconnect_keeps_its_reason()
    {
        var e = RdpFailures.WithoutDisconnect(SessionFailure.Timeout, "rpabot was not signed in within 60 s.", new ClientReports(LogonError: 1));

        Assert.Equal(SessionFailure.Timeout, e.Reason);
        Assert.Equal("rpabot was not signed in within 60 s. It reported logon error 1.", e.Message);
    }

    [Theory]
    [InlineData(SessionFailure.Timeout)]
    [InlineData(SessionFailure.HostExited)]
    public void An_attempt_that_ends_without_a_disconnect_after_a_dialog_is_Refused(SessionFailure reason)
    {
        // The dialog may have been about the sign-in: no retry, but no block either.
        var e = RdpFailures.WithoutDisconnect(reason, "rpabot was not signed in within 60 s.", new ClientReports("Your credentials did not work"));

        Assert.Equal(SessionFailure.Refused, e.Reason);
        Assert.Equal("rpabot was not signed in within 60 s. The Remote Desktop client showed: \"Your credentials did not work\".", e.Message);
    }
}
