namespace Rpa.Supervisor.Core;

public enum SessionState { Active, Disconnected, Other }

/// <summary>A Windows session of a user. Windows reuses session ids, so a session is told apart by its id and its
/// logon time together.</summary>
public sealed record SessionInfo(uint Id, string User, SessionState State, DateTimeOffset LogonTime);

/// <summary>The sessions on this machine (Windows: WTSEnumerateSessions and WTSLogoffSession).</summary>
public interface ISessions
{
    /// <summary>Every session of the user, in any state.</summary>
    IReadOnlyList<SessionInfo> ForUser(string user);

    /// <summary>Signs the session out and returns when it is gone.</summary>
    Task SignOutAsync(uint sessionId, CancellationToken ct);
}

/// <summary>The machine's Remote Desktop service (Windows: TermService) and its port. While the service is stopped any
/// user may listen on the port, and such a listener stays after the service starts again; a sign-in would go to it. So
/// no sign-in is tried until the service runs and every listener on the port is the service's.</summary>
public interface IRemoteDesktopService
{
    /// <summary>Null when the service runs and owns every listener on its port; otherwise why not (RemoteDesktopPort).</summary>
    string? Problem();
}

/// <summary>Signs the bot user in over a Remote Desktop connection from the machine to itself. The implementation
/// reads the password itself; it never passes through the supervisor's logic.</summary>
public interface IRdpHost
{
    // Signs the user in. Returns when the session is Active; throws SessionException otherwise.
    Task<IRdpConnection> ConnectAsync(string user, CancellationToken ct);
}

/// <summary>A Remote Desktop connection that holds a session. Closed completes when the connection ends for any
/// reason; disposing it ends the connection.</summary>
public interface IRdpConnection : IAsyncDisposable
{
    uint SessionId { get; }
    Task Closed { get; }
}

/// <summary>Why a sign-in failed. Timeout and HostExited are tried again; WrongPassword and PasswordExpired stop every
/// sign-in until the service restarts; the others fail the connection and the next connection tries again. Refused: the
/// Remote Desktop client refused the sign-in for a reason that is not known to concern the password.</summary>
public enum SessionFailure { UserSignedIn, WrongPassword, PasswordExpired, NotAllowed, Timeout, HostExited, NoPassword, Refused }

public sealed class SessionException(SessionFailure reason, string message) : Exception(message)
{
    public SessionFailure Reason => reason;
}
