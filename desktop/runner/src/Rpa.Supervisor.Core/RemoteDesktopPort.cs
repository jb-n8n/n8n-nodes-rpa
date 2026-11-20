namespace Rpa.Supervisor.Core;

/// <summary>Whether a sign-in may go to the Remote Desktop port, from what Windows says about the service and about who
/// listens on the port.</summary>
public static class RemoteDesktopPort
{
    public const int Number = 3389;

    /// <summary>Null when the service runs (its process id is not 0), something listens on the port, and every
    /// listener there is that process; otherwise the reason, as a clause without a full stop. No listener at all is a
    /// problem of its own, so that a machine with Remote Desktop turned off says so and no connection is tried.</summary>
    public static string? Problem(bool running, uint serviceProcessId, IEnumerable<uint> listenerOwners)
    {
        if (!running || serviceProcessId == 0) return "The Remote Desktop service (TermService) is not running";
        var owners = listenerOwners.ToArray();
        if (owners.Length == 0)
            return $"Nothing listens on the Remote Desktop port {Number}: Remote Desktop is turned off, or its service is still starting";
        var others = owners.Where(owner => owner != serviceProcessId).Distinct().Order().ToArray();
        return others.Length == 0
            ? null
            : $"Another program (process {string.Join(", ", others)}) listens on the Remote Desktop port {Number}";
    }
}
