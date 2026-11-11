using System.ComponentModel;
using System.ServiceProcess;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>Whether the machine's Remote Desktop service (TermService) is running. While it runs, it holds the Remote
/// Desktop port and a standard user cannot listen there; while it is stopped, anyone may. This says nothing about who
/// answers on the port once the check is done.</summary>
internal sealed class RemoteDesktopService : IRemoteDesktopService
{
    private const string Name = "TermService";

    public bool IsRunning
    {
        get
        {
            try
            {
                using var service = new ServiceController(Name);
                return service.Status == ServiceControllerStatus.Running;
            }
            catch (Exception e) when (e is InvalidOperationException or Win32Exception)
            {
                return false; // missing, or its state cannot be read
            }
        }
    }
}
