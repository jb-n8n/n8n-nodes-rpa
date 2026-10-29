using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Rpa.Runner.Core.Server;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Windows;

/// <summary>
/// Processes on Windows. Each launched process goes into its own job object (kill-on-close), so its descendants are
/// known exactly (a reused process id is never in the job), the whole tree ends with the job, and the apps die with the
/// runner if it crashes. Image names via QueryFullProcessImageName, parents via a Toolhelp snapshot.
/// </summary>
public sealed class WindowsProcessHost : SystemProcessHost
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<int, IntPtr> _jobs = new();

    protected override void AfterStart(Process p)
    {
        // A process can start children before it is assigned; the parent-link check below still covers those.
        var job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var size = Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info, (uint)size);
            if (Native.AssignProcessToJobObject(job, p.Handle)) _jobs[p.Id] = job;
            else Native.CloseHandle(job);
        }
        try { p.WaitForInputIdle(10000); }
        catch (InvalidOperationException) { /* no message loop (yet) */ }
    }

    public override bool IsDescendantOf(int pid, IReadOnlyCollection<int> roots)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h != IntPtr.Zero)
        {
            try
            {
                foreach (var root in roots)
                    if (_jobs.TryGetValue(root, out var job) && Native.IsProcessInJob(h, job, out var inJob) && inJob) return true;
            }
            finally
            {
                Native.CloseHandle(h);
            }
        }
        return base.IsDescendantOf(pid, roots);
    }

    public override void KillTree(int pid)
    {
        if (_jobs.TryRemove(pid, out var job))
        {
            Native.TerminateJobObject(job, 1);
            Native.CloseHandle(job);
        }
        base.KillTree(pid);
    }

    public override string? GetExeName(int pid)
    {
        var path = GetExePath(pid);
        return path is null ? base.GetExeName(pid) : Path.GetFileName(path);
    }

    public override string? GetExePath(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            var size = (uint)sb.Capacity;
            return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null;
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
