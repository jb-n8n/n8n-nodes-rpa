using System.ServiceProcess;

namespace Rpa.Supervisor;

internal static class Program
{
    /// <summary>The argument that starts the Remote Desktop host; only the service starts it.</summary>
    internal const string RdpHostMode = "rdp-host";

    // STA: the Remote Desktop host holds an ActiveX control.
    [STAThread]
    private static int Main(string[] args)
    {
        switch (args)
        {
            case [RdpHostMode]:
                return RdpHostWindow.Run();
            case [] when !Environment.UserInteractive:
                ServiceBase.Run(new SupervisorService());
                return 0;
            default:
                Console.Error.WriteLine(
                    $"RpaSupervisor.exe runs as the Windows service \"{SupervisorService.Name}\", which the installer registers; start it with: sc.exe start \"{SupervisorService.Name}\"");
                return 2;
        }
    }
}
