using System.ComponentModel;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>Whether the machine's Remote Desktop service (TermService) runs and is the only process that listens on the
/// Remote Desktop port. While it runs, a standard user cannot start listening there; but a listener on one address (such
/// as 127.0.0.2) made while it was stopped stays after it starts again, and takes the connections to that address. This
/// is a check at one point in time: it says nothing about who answers on the port after it.</summary>
internal sealed class RemoteDesktopService : IRemoteDesktopService
{
    private const string Name = "TermService";
    private const int ErrorInsufficientBuffer = 122;

    public string? Problem()
    {
        try
        {
            using var service = new ServiceController(Name);
            var running = service.Status == ServiceControllerStatus.Running;
            return RemoteDesktopPort.Problem(running, running ? ProcessIdOf(service) : 0, ListenerOwners());
        }
        catch (Exception e) when (e is InvalidOperationException or Win32Exception)
        {
            // Missing, or its state or the port's listeners cannot be read: not ready.
            return $"The Remote Desktop service (TermService) and its port could not be checked ({e.Message})";
        }
    }

    private static uint ProcessIdOf(ServiceController service)
    {
        var size = Marshal.SizeOf<SERVICE_STATUS_PROCESS>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryServiceStatusEx(service.ServiceHandle, ScStatusProcessInfo, buffer, size, out _)) throw new Win32Exception();
            return Marshal.PtrToStructure<SERVICE_STATUS_PROCESS>(buffer).dwProcessId;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    // The owning process of every IPv4 and IPv6 TCP listener on the port (TCP_TABLE_OWNER_PID_LISTENER). A table is a
    // count, then rows: MIB_TCPROW_OWNER_PID (24 bytes, port at 8, process at 20) and MIB_TCP6ROW_OWNER_PID (56 bytes,
    // port at 20, process at 52). A port is in network byte order in the low 16 bits.
    private static List<uint> ListenerOwners()
    {
        var owners = new List<uint>();
        foreach (var (family, rowSize, portOffset, ownerOffset) in new[] { (AfInet, 24, 8, 20), (AfInet6, 56, 20, 52) })
        {
            var table = ListenerTable(family);
            try
            {
                var count = Marshal.ReadInt32(table);
                for (var i = 0; i < count; i++)
                {
                    var row = table + 4 + i * rowSize;
                    var port = (ushort)Marshal.ReadInt32(row + portOffset);
                    if ((ushort)((port >> 8) | (port << 8)) == RemoteDesktopPort.Number) owners.Add((uint)Marshal.ReadInt32(row + ownerOffset));
                }
            }
            finally
            {
                Marshal.FreeHGlobal(table);
            }
        }
        return owners;
    }

    // The table grows when a listener appears between asking for its size and reading it: then ask again.
    private static IntPtr ListenerTable(int family)
    {
        var size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TcpTableOwnerPidListener, 0);
        for (var tries = 1; ; tries++)
        {
            var table = Marshal.AllocHGlobal(size);
            var error = GetExtendedTcpTable(table, ref size, false, family, TcpTableOwnerPidListener, 0);
            if (error == 0) return table;
            Marshal.FreeHGlobal(table);
            if (error != ErrorInsufficientBuffer || tries == 3) throw new Win32Exception(error);
        }
    }

    private const int ScStatusProcessInfo = 0;
    private const int AfInet = 2;
    private const int AfInet6 = 23;
    private const int TcpTableOwnerPidListener = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_STATUS_PROCESS
    {
        public uint dwServiceType, dwCurrentState, dwControlsAccepted, dwWin32ExitCode, dwServiceSpecificExitCode,
            dwCheckPoint, dwWaitHint, dwProcessId, dwServiceFlags;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceStatusEx(SafeHandle service, int infoLevel, IntPtr buffer, int size, out int needed);

    [DllImport("iphlpapi.dll")]
    private static extern int GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);
}
