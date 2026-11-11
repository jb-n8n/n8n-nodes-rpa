namespace Rpa.Supervisor.Core;

/// <summary>The supervisor's log. Messages must not hold a password, a token or bytes of a proxied connection.</summary>
public interface ISupervisorLog
{
    void Info(string message);

    /// <summary>A failure; reason is null when it is not a sign-in failure.</summary>
    void Failure(SessionFailure? reason, string message);
}
