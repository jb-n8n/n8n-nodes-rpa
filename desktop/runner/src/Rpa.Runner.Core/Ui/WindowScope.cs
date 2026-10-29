using System.Text.RegularExpressions;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;

namespace Rpa.Runner.Core.Ui;

/// <summary>
/// Which windows a run may touch: top-level windows owned by a process the run launched (or a descendant of one) whose
/// executable is in the policy's allowedApps. Child and owned windows of such a process (its dialogs, menus and
/// pop-ups) are top-level windows of the same process, so they count. Named OS surfaces are ignored: never acted on,
/// never a reason to refuse.
/// </summary>
public sealed class WindowScope
{
    /// <summary>OS surfaces (process, and window class where the process also owns ordinary windows).</summary>
    private static readonly (string Exe, string? ClassName)[] OsSurfaces =
    [
        ("ShellExperienceHost.exe", null),
        ("StartMenuExperienceHost.exe", null),
        ("SearchHost.exe", null),
        ("SearchApp.exe", null),
        ("SearchUI.exe", null),
        ("TextInputHost.exe", null),
        ("LockApp.exe", null),
        ("SecurityHealthSystray.exe", null),
        ("SecurityHealthHost.exe", null),
        ("MusNotification.exe", null),
        ("MusNotifyIcon.exe", null),
        ("smartscreen.exe", null),
        ("explorer.exe", "Shell_TrayWnd"),
        ("explorer.exe", "Shell_SecondaryTrayWnd"),
        ("explorer.exe", "Progman"),
        ("explorer.exe", "WorkerW"),
        ("explorer.exe", "NotifyIconOverflowWindow"),
        ("explorer.exe", "Windows.UI.Core.CoreWindow"),
    ];

    private readonly IDesktop _desktop;
    private readonly IProcessHost _processes;
    private readonly RunnerPolicy _policy;

    public WindowScope(IDesktop desktop, IProcessHost processes, RunnerPolicy policy)
    {
        _desktop = desktop;
        _processes = processes;
        _policy = policy;
    }

    public string? ExeOf(int pid) => _processes.GetExeName(pid);

    /// <summary>True when the process belongs to the run (launched by it, or a descendant) and is an allowed app.</summary>
    public bool IsRunProcess(RunState run, int pid)
    {
        if (!_policy.IsAllowedExe(_processes.GetExeName(pid))) return false;
        var launched = run.Processes;
        int? cur = pid;
        for (var i = 0; i < 16 && cur is int p; i++)
        {
            if (launched.Contains(p)) return true;
            cur = _processes.GetParentPid(p);
            if (cur == p) break;
        }
        return false;
    }

    public bool IsOsSurface(IUiNode window)
    {
        var exe = _processes.GetExeName(window.ProcessId);
        if (exe is null) return false;
        var cls = SafeClass(window);
        return OsSurfaces.Any(s => string.Equals(s.Exe, exe, StringComparison.OrdinalIgnoreCase) &&
                                   (s.ClassName is null || string.Equals(s.ClassName, cls, StringComparison.Ordinal)));
    }

    /// <summary>The run's windows matching the selector, front to back. A selector that only matches windows of other
    /// applications is a policy refusal (an OS surface is not a match).</summary>
    public IReadOnlyList<IUiNode> RunWindows(RunState run, WindowSel? sel)
    {
        var allowed = new List<IUiNode>();
        string? refusedExe = null;
        foreach (var w in _desktop.GetTopLevelWindows())
        {
            bool matches;
            try { matches = sel is null || Matches(w, sel); }
            catch (ElementGoneException) { continue; }
            if (!matches) continue;
            if (IsRunProcess(run, w.ProcessId)) allowed.Add(w);
            else if (sel is not null && refusedExe is null && !IsOsSurface(w)) refusedExe = _processes.GetExeName(w.ProcessId) ?? "unknown";
        }
        if (allowed.Count == 0 && refusedExe is not null)
            throw RpcErrors.PolicyRefused($"the window {sel} belongs to \"{refusedExe}\", which is not an application this run launched from the allowed list");
        return allowed;
    }

    /// <summary>The run's current window: the foreground window if it is the run's, else the front-most run window.</summary>
    public IUiNode? CurrentWindow(RunState run, WindowSel? sel = null)
    {
        if (sel is null)
        {
            var fg = _desktop.GetForegroundWindow();
            if (fg is not null && IsRunProcess(run, fg.ProcessId)) return fg;
        }
        return RunWindows(run, sel).FirstOrDefault();
    }

    public bool Matches(IUiNode w, WindowSel sel)
    {
        if (sel.Exe is not null &&
            !string.Equals(_processes.GetExeName(w.ProcessId), sel.Exe, StringComparison.OrdinalIgnoreCase)) return false;
        if (sel.Title is not null && !string.Equals(w.Name, sel.Title, StringComparison.Ordinal)) return false;
        if (sel.AutomationId is not null && !string.Equals(w.AutomationId, sel.AutomationId, StringComparison.Ordinal)) return false;
        if (sel.ClassName is not null && !string.Equals(w.ClassName, sel.ClassName, StringComparison.Ordinal)) return false;
        if (sel.TitlePattern is not null)
        {
            try
            {
                if (!Regex.IsMatch(w.Name, sel.TitlePattern, RegexOptions.None, TimeSpan.FromMilliseconds(100))) return false;
            }
            catch (RegexMatchTimeoutException) { return false; }
        }
        return true;
    }

    private static string SafeClass(IUiNode w)
    {
        try { return w.ClassName; }
        catch (ElementGoneException) { return ""; }
    }
}

/// <summary>The element went away while the runner was reading it (the UI changed). Callers retry.</summary>
public sealed class ElementGoneException(string message, Exception? inner = null) : Exception(message, inner);
