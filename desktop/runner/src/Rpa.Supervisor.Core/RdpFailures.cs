namespace Rpa.Supervisor.Core;

/// <summary>
/// Why a Remote Desktop sign-in failed, from the client control's disconnect reason and extended reason. SessionManager
/// retries Timeout and HostExited every 2 s, and retrying a refused password can lock the account out, so every
/// failure that may concern the password maps to WrongPassword or PasswordExpired, also when that is not certain.
/// </summary>
public static class RdpFailures
{
    private const int LogonFailed = 2055;
    private const int PasswordExpired = 3847;
    private const int PasswordMustChange = 4615;
    private const int ExtendedNotAllowed = 9; // the user may not sign in through Remote Desktop
    private const int ExtendedFreshCredentials = 10; // the server asks for credentials typed in
    // The client's security layer (TLS and Network Level Authentication) reports its failures with reasons whose low
    // byte is 7: 2055 and 3847 above, a disabled, locked or expired account, an unknown user, and 519, which a
    // client in the service's session gives when the domain is empty.
    private const int SecurityLayerClass = 0x07;

    public static SessionException FromDisconnect(string user, int reason, int extended, string description, string? dialog)
    {
        var numbers = $"Remote Desktop disconnect reason {reason}";
        var described = description.Length > 0 ? $": {description}" : "";
        var e = reason switch
        {
            LogonFailed => new SessionException(SessionFailure.WrongPassword,
                $"Windows refused the password of {user} ({numbers}{described})."),
            PasswordExpired or PasswordMustChange => new SessionException(SessionFailure.PasswordExpired,
                $"The password of {user} has expired or must be changed ({numbers}{described}). Set a new one and store it for the RPA Supervisor again."),
            _ when extended == ExtendedNotAllowed => new SessionException(SessionFailure.NotAllowed,
                $"{user} may not sign in through Remote Desktop; it needs to be in the Remote Desktop Users group ({numbers}, extended reason {extended}{described})."),
            _ when (reason & 0xFF) == SecurityLayerClass || extended == ExtendedFreshCredentials => new SessionException(SessionFailure.WrongPassword,
                $"The Remote Desktop sign-in of {user} failed in the client's security layer ({numbers}, extended reason {extended}{described}). It may be a password or account problem, so it is treated as a refused password."),
            _ => new SessionException(SessionFailure.HostExited,
                $"The Remote Desktop connection for {user} ended before the session was ready ({numbers}, extended reason {extended}{described})."),
        };
        return dialog is null ? e : new SessionException(e.Reason, $"{e.Message}{Showed(dialog)}");
    }

    /// <summary>An attempt that ended without a disconnect reason (timed out, or the host ended). After a dialog of the
    /// client it counts as a refused password: the dialog may have been about it.</summary>
    public static SessionException WithoutDisconnect(SessionFailure reason, string message, string? dialog) =>
        dialog is null
            ? new SessionException(reason, message)
            : new SessionException(SessionFailure.WrongPassword,
                $"{message}{Showed(dialog)} It may be a password problem, so it is treated as a refused password.");

    private static string Showed(string dialog) => $" The Remote Desktop client showed: \"{dialog}\".";
}
