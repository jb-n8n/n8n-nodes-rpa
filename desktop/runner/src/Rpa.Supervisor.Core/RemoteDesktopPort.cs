namespace Rpa.Supervisor.Core;

/// <summary>Whether a sign-in may go to the Remote Desktop port, from what Windows says about the service and about who
/// listens on the port.</summary>
public static class RemoteDesktopPort
{
    public const int Number = 3389;

    /// <summary>Null when the service runs (its process id is not 0) and every listener on the port is that process;
    /// otherwise the reason, as a clause without a full stop. No listener at all is not a problem here: the connection
    /// then fails on its own.</summary>
    public static string? Problem(bool running, uint serviceProcessId, IEnumerable<uint> listenerOwners)
    {
        if (!running || serviceProcessId == 0) return "The Remote Desktop service (TermService) is not running";
        var others = listenerOwners.Where(owner => owner != serviceProcessId).Distinct().Order().ToArray();
        return others.Length == 0
            ? null
            : $"Another program (process {string.Join(", ", others)}) listens on the Remote Desktop port {Number}";
    }
}
