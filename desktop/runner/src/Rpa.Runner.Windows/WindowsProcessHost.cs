using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Rpa.Runner.Core.Server;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Windows;

/// <summary>Processes on Windows: image names via QueryFullProcessImageName, parents via a Toolhelp snapshot, and a
/// wait for a launched app's first idle moment.</summary>
public sealed class WindowsProcessHost : SystemProcessHost
{
    protected override void AfterStart(Process p)
    {
        try { p.WaitForInputIdle(10000); }
        catch (InvalidOperationException) { /* no message loop (yet) */ }
    }

    public override string? GetExeName(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == IntPtr.Zero) return base.GetExeName(pid);
        try
        {
            var sb = new StringBuilder(1024);
            var size = (uint)sb.Capacity;
            return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? Path.GetFileName(sb.ToString()) : base.GetExeName(pid);
        }
        finally
        {
            Native.CloseHandle(h);
        }
    }

    public override int? GetParentPid(int pid)
    {
        var snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return null;
        try
        {
            var e = new Native.PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<Native.PROCESSENTRY32W>() };
            if (!Native.Process32FirstW(snap, ref e)) return null;
            do
            {
                if (e.th32ProcessID == (uint)pid) return (int)e.th32ParentProcessID;
            } while (Native.Process32NextW(snap, ref e));
            return null;
        }
        finally
        {
            Native.CloseHandle(snap);
        }
    }
}

/// <summary>Protects the stored certificate key with DPAPI for the runner's Windows user.</summary>
public sealed class DpapiKeyProtector : IKeyProtector
{
    private static readonly byte[] Entropy = "RPA Runner certificate v1"u8.ToArray();

    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);

    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, Entropy, DataProtectionScope.CurrentUser);
}
