using System.Diagnostics;

namespace Rpa.Runner.Core.Ui;

/// <summary>Processes through System.Diagnostics.Process. Parent ids come from /proc on Linux; Windows overrides
/// <see cref="GetParentPid"/>. Keeps a handle to every process it started until <see cref="KillTree"/>, so the
/// operating system cannot reuse that process id for an unrelated process in the meantime.</summary>
public class SystemProcessHost : IProcessHost
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<int, Process> _started = new();

    public virtual int Start(string exePath, IReadOnlyList<string> args)
    {
        var psi = new ProcessStartInfo(exePath)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(exePath) ?? Environment.CurrentDirectory,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        var p = Process.Start(psi) ?? throw new InvalidOperationException("the process did not start");
        _started[p.Id] = p;
        AfterStart(p);
        return p.Id;
    }

    /// <summary>Hook for platform waits (Windows waits for the app to become idle).</summary>
    protected virtual void AfterStart(Process p)
    {
    }

    public virtual string? GetExeName(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return OperatingSystem.IsWindows() ? p.ProcessName + ".exe" : p.ProcessName;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return null;
        }
    }

    public virtual int? GetParentPid(int pid)
    {
        if (!OperatingSystem.IsLinux()) return null;
        try
        {
            var stat = File.ReadAllText($"/proc/{pid}/stat");
            var close = stat.LastIndexOf(')');
            var fields = stat[(close + 2)..].Split(' ');
            return int.Parse(fields[1], System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is IOException or FormatException or IndexOutOfRangeException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public virtual bool IsDescendantOf(int pid, IReadOnlyCollection<int> roots)
    {
        var child = pid;
        var childStart = GetStartTime(child);
        for (var i = 0; i < 16 && childStart is not null; i++)
        {
            if (GetParentPid(child) is not int parent || parent == child) return false;
            var parentStart = GetStartTime(parent);
            // A parent that started after its "child" is a reused id, not the real parent.
            if (parentStart is null || parentStart > childStart) return false;
            if (roots.Contains(parent)) return true;
            child = parent;
            childStart = parentStart;
        }
        return false;
    }

    protected virtual DateTime? GetStartTime(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.StartTime.ToUniversalTime();
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>Kills a process this host started (never another process that happens to have the id).</summary>
    public virtual void KillTree(int pid)
    {
        if (!_started.TryRemove(pid, out var p)) return;
        using (p)
        {
            try
            {
                if (!p.HasExited)
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(5000);
                }
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // Already gone, or exiting.
            }
        }
    }
}
