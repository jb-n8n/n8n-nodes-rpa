namespace Rpa.Supervisor.Core;

/// <summary>What the Remote Desktop client said during an attempt besides its disconnect: the first message box it
/// showed, and the last logon error and warning it reported.</summary>
public sealed record ClientReports(string? Dialog = null, int? LogonError = null, int? Warning = null)
{
    public static readonly ClientReports None = new();

    internal string Text =>
        (Dialog is null ? "" : $" The Remote Desktop client showed: \"{Dialog}\".")
        + (LogonError is { } error ? $" It reported logon error {error}." : "")
        + (Warning is { } warning ? $" It reported warning {warning}." : "");
}

/// <summary>
/// Why a Remote Desktop sign-in failed, from the client control's disconnect reason and extended reason. SessionManager
/// tries Timeout and HostExited again every 2 s, and stops every sign-in after WrongPassword or PasswordExpired until
/// the service restarts, because retrying a refused password can lock the account out. Only reasons known to concern
/// the password or the account block; another failure of the client's security layer is Refused: the connection
/// fails, and the next one tries again.
/// </summary>
public static class RdpFailures
{
    private const int LogonFailed = 2055;
    // An unknown user, a disabled account, a logon restriction, a locked account, an expired account.
    private static readonly int[] AccountRefused = [2567, 2823, 3079, 3335, 3591];
    private const int PasswordExpired = 3847;
    private const int PasswordMustChange = 4615;
    private const int ExtendedNotAllowed = 9; // the user may not sign in through Remote Desktop
    private const int ExtendedFreshCredentials = 10; // the server asks for credentials typed in
    // The client's security layer (TLS and Network Level Authentication) reports its failures with reasons whose low
    // byte is 7: the ones above, and others such as 519, which a client in the service's session gives when the
    // domain is empty.
    private const int SecurityLayerClass = 0x07;

    public static SessionException FromDisconnect(string user, int reason, int extended, string description, ClientReports reports)
    {
        var numbers = $"Remote Desktop disconnect reason {reason}, extended reason {extended}"
            + (description.Length > 0 ? $": {description}" : "");
        var (failure, message) = reason switch
        {
            LogonFailed => (SessionFailure.WrongPassword, $"Windows refused the password of {user} ({numbers})."),
            _ when AccountRefused.Contains(reason) || extended == ExtendedFreshCredentials => (SessionFailure.WrongPassword,
                $"Windows refused the sign-in of {user} because of its password or account ({numbers})."),
            PasswordExpired or PasswordMustChange => (SessionFailure.PasswordExpired,
                $"The password of {user} has expired or must be changed ({numbers}). Set a new one and store it for the RPA Supervisor again."),
            _ when extended == ExtendedNotAllowed => (SessionFailure.NotAllowed,
                $"{user} may not sign in through Remote Desktop; it needs to be in the Remote Desktop Users group ({numbers})."),
            _ when (reason & 0xFF) == SecurityLayerClass => (SessionFailure.Refused,
                $"The Remote Desktop client refused the sign-in of {user} ({numbers})."),
            _ => (SessionFailure.HostExited,
                $"The Remote Desktop connection for {user} ended before the session was ready ({numbers})."),
        };
        return new SessionException(failure, message + reports.Text);
    }

    /// <summary>An attempt that ended without a disconnect reason (timed out, or the host ended). After a message box
    /// of the client it is Refused: the box may have been about the sign-in, so the attempt is not repeated, and it does
    /// not count as a refused password either.</summary>
    public static SessionException WithoutDisconnect(SessionFailure reason, string message, ClientReports reports) =>
        new(reports.Dialog is null ? reason : SessionFailure.Refused, message + reports.Text);
}
