using System.Text.Json.Nodes;
using Rpa.Runner.Core.Files;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core;

/// <summary>
/// The protocol's methods. Order of checks for UI methods: run id, params, session health, then target resolution and
/// the policy floor, then the action. UI work is serialised (one UI call at a time across connections).
/// </summary>
public sealed class RunnerService
{
    public const int Protocol = 1;
    public const int DefaultMaxNodes = 400;
    public const int DefaultMaxDepth = 25;
    public const long MaxTimeoutMs = 600000;
    public const int MaxWindows = 20;
    private const long DefaultActTimeoutMs = 10000;
    private const long DefaultFileTimeoutMs = 30000;

    private const string RepairRefusal =
        "repair mode allows only focus, expand, read, Escape without a target, and click on tabs, list items and tree items";

    private static readonly HashSet<string> RepairClickable = new(StringComparer.OrdinalIgnoreCase) { "TabItem", "ListItem", "TreeItem" };

    private readonly IDesktop _desktop;
    private readonly IProcessHost _processes;
    private readonly IPathSecurity _paths;
    private readonly RunnerPolicy _policy;
    private readonly RunManager _runs;
    private readonly WindowScope _scope;
    private readonly TargetResolver _resolver;
    private readonly ExportFiles _files;
    private readonly TimeProvider _time;
    private readonly RunnerLog _log;
    private readonly SemaphoreSlim _uiGate = new(1, 1);
    private readonly string _version;

    public RunnerService(IDesktop desktop, IProcessHost processes, RunnerPolicy policy, RunManager runs, TimeProvider time,
        RunnerLog log, string version, IPathSecurity? paths = null)
    {
        _desktop = desktop;
        _processes = processes;
        _paths = paths ?? new DefaultPathSecurity();
        _policy = policy;
        _runs = runs;
        _time = time;
        _log = log;
        _version = version;
        _scope = new WindowScope(desktop, processes, policy);
        _resolver = new TargetResolver(_scope, time);
        _files = new ExportFiles(time);
    }

    public RunManager Runs => _runs;

    public JsonNode Invoke(string method, Params p, CancellationToken ct)
    {
        try
        {
            return Dispatch(method, p, ct);
        }
        catch (ElementGoneException)
        {
            throw RpcErrors.Timeout("the UI kept changing while the runner read it");
        }
    }

    private JsonNode Dispatch(string method, Params p, CancellationToken ct) => method switch
    {
        "hello" => Hello(),
        "run.begin" => RunBegin(p),
        "run.heartbeat" => RunHeartbeat(p),
        "run.end" => RunEnd(p),
        "app.launch" => WithRun(p, ct, AppLaunch),
        "snapshot" => WithRun(p, ct, Snapshot),
        "isVisible" => WithRun(p, ct, IsVisible),
        "resolve" => WithRun(p, ct, Resolve),
        "act" => WithRun(p, ct, Act),
        "windows" => WithRun(p, ct, Windows),
        "file.retrieve" => WithRun(p, ct, FileRetrieve, ui: false),
        "screenshot" => WithRun(p, ct, Screenshot),
        _ => throw new RpcException(RpcErrors.MethodNotFound, "method_not_found", "method not found"),
    };

    private JsonNode Hello()
    {
        var s = _desktop.GetSessionState();
        return new JsonObject
        {
            ["protocol"] = Protocol,
            ["runner"] = new JsonObject
            {
                ["version"] = _version,
                ["os"] = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
                ["session"] = new JsonObject { ["interactive"] = s.Interactive, ["locked"] = s.Locked },
            },
        };
    }

    private JsonNode RunBegin(Params p)
    {
        var runId = p.ReqString("runId");
        var lease = p.ReqLong("leaseMs", RunManager.MinLeaseMs, RunManager.MaxLeaseMs);
        RequireSession();
        var run = _runs.Begin(runId, lease);
        return new JsonObject { ["exportDir"] = run.ExportDir };
    }

    private JsonNode RunHeartbeat(Params p)
    {
        _runs.Heartbeat(p.OptString("runId"));
        return new JsonObject();
    }

    private JsonNode RunEnd(Params p)
    {
        _runs.End(p.OptString("runId"));
        return new JsonObject();
    }

    private JsonNode WithRun(Params p, CancellationToken ct, Func<RunState, Params, CancellationToken, JsonNode> handler, bool ui = true)
    {
        var runId = p.OptString("runId");
        using var scope = _runs.Enter(runId);
        var run = _runs.Get(runId);
        if (!ui) return handler(run, p, ct);
        _uiGate.Wait(ct);
        try
        {
            // The run may have ended while this request waited for the UI.
            run = _runs.Get(runId);
            return handler(run, p, ct);
        }
        finally
        {
            _uiGate.Release();
        }
    }

    private void RequireSession()
    {
        var s = _desktop.GetSessionState();
        if (!s.Usable) throw RpcErrors.DesktopUnavailable(s.Problem());
    }

    private JsonNode AppLaunch(RunState run, Params p, CancellationToken ct)
    {
        var app = p.ReqApp("app");
        var entry = _policy.ResolveLaunch(app.Exe, app.Args);
        var path = entry.Path;
        RequireSession();
        if (!File.Exists(path)) throw RpcErrors.NotFound($"application executable \"{entry.Exe}\"", null);
        if (!entry.AllowUserWritable && _paths.IsWritableByRunnerUser(path))
            throw RpcErrors.PolicyRefused($"\"{entry.Exe}\" sits where the runner's own user can replace it; install it in a protected folder or set allowUserWritable in the policy");
        int pid;
        // Held open (sharing reads only) from the hash check until the process has started, so the file cannot be
        // swapped in between.
        using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (entry.Sha256 is not null &&
                !string.Equals(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(f)), entry.Sha256, StringComparison.Ordinal))
                throw RpcErrors.PolicyRefused($"\"{entry.Exe}\" does not match the sha256 the policy pins");
            pid = _processes.Start(path, app.Args);
        }
        if (!run.TryAddProcess(pid))
        {
            // run.end (or the lease) ended the run while the app started: stop it now rather than leak it.
            _processes.KillTree(pid);
            throw RpcErrors.NoRun();
        }
        _log.Info($"app.launch {Path.GetFileName(path)} pid={pid}");
        return new JsonObject { ["pid"] = pid };
    }

    private JsonNode Snapshot(RunState run, Params p, CancellationToken ct)
    {
        var sel = p.OptWindow("window");
        var maxNodes = (int)(p.OptLong("maxNodes", 1, 5000) ?? DefaultMaxNodes);
        var maxDepth = (int)(p.OptLong("maxDepth", 1, 100) ?? DefaultMaxDepth);
        RequireSession();
        var window = _scope.CurrentWindow(run, sel)
                     ?? throw RpcErrors.NotFound(sel is null ? "a window of the run" : $"window {sel}", null);
        var result = SnapshotBuilder.Build(window, maxNodes, maxDepth);
        var nodes = new JsonArray();
        foreach (var n in result.Nodes) nodes.Add(System.Text.Json.JsonSerializer.SerializeToNode(n));
        var o = new JsonObject
        {
            ["window"] = new JsonObject { ["title"] = window.Name, ["exe"] = _scope.ExeOf(window.ProcessId) ?? "" },
            ["nodes"] = nodes,
        };
        if (result.Truncated) o["truncated"] = true;
        return o;
    }

    private JsonNode IsVisible(RunState run, Params p, CancellationToken ct)
    {
        var target = p.ReqTarget("target");
        RequireSession();
        return new JsonObject { ["visible"] = _resolver.AnyVisible(run, target) };
    }

    private JsonNode Resolve(RunState run, Params p, CancellationToken ct)
    {
        var target = p.ReqTarget("target");
        var timeout = TimeSpan.FromMilliseconds(p.OptLong("timeoutMs", 0, MaxTimeoutMs) ?? 0);
        RequireSession();
        var r = _resolver.Resolve(run, target, timeout, ct);
        return new JsonObject { ["candidate"] = r.Candidate };
    }

    private JsonNode Act(RunState run, Params p, CancellationToken ct)
    {
        var action = p.ReqAction("action");
        // An extension to the contract: key may omit the target and goes to the run's focused element.
        var target = action == ActionKind.Key ? p.OptTarget("target") : p.ReqTarget("target");
        var value = p.OptString("value");
        var segments = p.OptSegments("segments");
        var write = p.OptBool("write") ?? false;
        var mode = p.OptMode("mode");
        var timeout = TimeSpan.FromMilliseconds(p.OptLong("timeoutMs", 0, MaxTimeoutMs) ?? DefaultActTimeoutMs);
        var deadline = _time.GetUtcNow() + timeout;

        string? text = null;
        KeyChord? chord = null;
        switch (action)
        {
            case ActionKind.Type:
                if ((value is null) == (segments is null)) throw RpcErrors.InvalidParamsError("type needs exactly one of value or segments");
                text = value ?? Segments.Compose(segments!, run.ExportDir);
                break;
            case ActionKind.Select:
                if (segments is not null) throw RpcErrors.InvalidParamsError("segments are only allowed for type");
                text = value ?? throw RpcErrors.InvalidParamsError("select needs value (the item's name)");
                break;
            case ActionKind.Key:
                if (segments is not null) throw RpcErrors.InvalidParamsError("segments are only allowed for type");
                chord = KeyChord.Parse(value ?? throw RpcErrors.InvalidParamsError("key needs value (a key chord)"));
                break;
            default:
                if (segments is not null || value is not null)
                    throw RpcErrors.InvalidParamsError($"{action.ToString().ToLowerInvariant()} takes no value or segments");
                break;
        }

        // Floor checks that need no UI.
        if (mode == ActMode.Repair && action is not (ActionKind.Focus or ActionKind.Expand or ActionKind.Read or ActionKind.Click or ActionKind.Key))
            throw RpcErrors.PolicyRefused(RepairRefusal);
        if (chord is not null && IsSystemChord(chord))
            throw RpcErrors.PolicyRefused($"the key {chord} reaches the Windows shell, not the app, and is never sent");
        if (chord is not null && _policy.IsGatedKey(chord))
        {
            if (mode == ActMode.Repair) throw RpcErrors.PolicyRefused($"the gated key {chord} is never allowed in repair mode");
            if (!write) throw RpcErrors.PolicyRefused($"the gated key {chord} needs write: true");
        }
        // Repair may close a menu or dialog with Escape (to the run's focused element), and press no other key.
        if (mode == ActMode.Repair && action == ActionKind.Key && (target is not null || chord!.ToString() != "Escape"))
            throw RpcErrors.PolicyRefused(RepairRefusal);

        RequireSession();
        var res = target is null ? FocusedResolution(run, deadline, ct) : _resolver.Resolve(run, target, Remaining(deadline), ct);
        var element = res.Element;
        var what = target?.Describe() ?? "the focused element";

        CheckWriteControl(element, res.Window, write, mode, "the target");
        if (mode == ActMode.Repair && action == ActionKind.Key) CheckRepairEscape(run, res.Window);
        if (mode == ActMode.Repair && action == ActionKind.Click && !RepairClickable.Contains(element.ControlType))
            throw RpcErrors.PolicyRefused($"repair mode may click only tabs, list items and tree items, not a {element.ControlType}");
        if (action == ActionKind.Read && Redaction.HidesValue(element))
            throw RpcErrors.PolicyRefused("reading a password or credential field is not allowed");

        // Keys can reach a write control without targeting it (Enter on a default button, Space on a focused button, an
        // Alt mnemonic, F10 or Alt into the menu bar, Shift+F10 or Apps into a context menu, then arrows and Enter). So
        // while any window of the run holds a write control, a key without write: true must be plain navigation, and
        // not even that while a menu is open.
        if (chord is not null && !write && RunHasWriteControl(run))
        {
            if (!IsNavigationKey(chord))
                throw RpcErrors.PolicyRefused($"the key {chord} could reach a declared write control of this run and needs write: true (only Tab, arrows, Home, End, PageUp, PageDown and Escape do not)");
            if (chord.Key is not ("Escape" or "Tab") && RunMenuOpen(run))
                throw RpcErrors.PolicyRefused($"a menu is open, so the key {chord} could reach a declared write control and needs write: true");
        }

        EnsureForeground(run, res.Window);

        void Guard(IUiNode receiver)
        {
            if (!_scope.IsRunProcess(run, receiver.ProcessId))
                throw RpcErrors.PolicyRefused("the input would reach a window of another application");
            CheckWriteControl(receiver, res.Window, write, mode, "the element under the pointer or with the keyboard focus");
            // Where the pointer lands; a repair-mode key (Escape) goes to the focused element, which is its target.
            if (mode == ActMode.Repair && action != ActionKind.Key) CheckRepairReceiver(receiver, element);
            // Right before the key goes out: the popup menu that allowed a repair-mode Escape may have closed.
            if (mode == ActMode.Repair && action == ActionKind.Key) CheckRepairEscape(run, res.Window);
        }

        while (true)
        {
            try
            {
                var outText = _desktop.Perform(new UiOperation(element, res.Window, action, text, chord, Remaining(deadline), Guard));
                _log.Info($"act {action} candidate={res.Candidate}{(write ? " write" : "")}{(mode == ActMode.Repair ? " repair" : "")}");
                var o = new JsonObject();
                if (action == ActionKind.Read) o["text"] = outText ?? "";
                return o;
            }
            catch (RetryableActionException e)
            {
                if (_time.GetUtcNow() >= deadline) throw RpcErrors.Timeout($"{e.Message} ({what})");
                ct.ThrowIfCancellationRequested();
                Thread.Sleep(TargetResolver.PollInterval);
            }
            catch (ElementGoneException)
            {
                if (_time.GetUtcNow() >= deadline) throw RpcErrors.Timeout($"the element went away while acting on it ({what})");
                Thread.Sleep(TargetResolver.PollInterval);
                res = target is null ? FocusedResolution(run, deadline, ct) : _resolver.Resolve(run, target, Remaining(deadline), ct);
                element = res.Element;
                CheckWriteControl(element, res.Window, write, mode, "the target");
                if (mode == ActMode.Repair && action == ActionKind.Key) CheckRepairEscape(run, res.Window);
            }
        }
    }

    /// <summary>Escape fires a form's cancel button (WinForms CancelButton, a Win32 dialog's IDCANCEL) whatever has the
    /// focus, so in repair mode it is refused when its window holds a declared write control, unless a popup menu of that
    /// window is open (then Escape only closes the menu).</summary>
    private void CheckRepairEscape(RunState run, IUiNode window)
    {
        if (WindowHasWriteControl(window) && !PopupMenuOpenFor(run, window))
            throw RpcErrors.PolicyRefused("in repair mode Escape could press a declared write control of this window (a cancel button), so it is allowed only while a menu is open");
    }

    /// <summary>
    /// An allow decision, so it fails closed: true only when a popup menu is open for the window, that is a visible,
    /// on-screen top-level window of the run that is a Menu (or a Win32 popup menu, class #32768) and is the foreground
    /// window or owned (Win32 owner chain) by the window. A menu bar or any element inside the window never counts; a
    /// window that goes away while being read, or an owner that cannot be told, means no.
    /// </summary>
    private bool PopupMenuOpenFor(RunState run, IUiNode window)
    {
        try
        {
            var fg = _desktop.GetForegroundWindow();
            foreach (var w in _scope.RunWindows(run, null))
            {
                if (w.Id == window.Id) continue;
                if (!(string.Equals(w.ControlType, "Menu", StringComparison.OrdinalIgnoreCase) || w.ClassName == "#32768") || w.IsOffscreen) continue;
                if (fg is not null && fg.Id == w.Id) return true;
                var owner = _desktop.GetOwnerWindow(w);
                for (var i = 0; i < 8 && owner is not null; i++)
                {
                    if (owner.Id == window.Id) return true;
                    owner = _desktop.GetOwnerWindow(owner);
                }
            }
        }
        catch (ElementGoneException)
        {
            return false;
        }
        return false;
    }

    /// <summary>The run's top-level windows (its processes' own and owned windows, never another application's): the
    /// foreground window first when it is the run's, then front to back, at most <see cref="MaxWindows"/>. A window that
    /// goes away while being read is left out.</summary>
    private JsonNode Windows(RunState run, Params p, CancellationToken ct)
    {
        RequireSession();
        string? fgId = null;
        try
        {
            var fg = _desktop.GetForegroundWindow();
            if (fg is not null && _scope.IsRunProcess(run, fg.ProcessId)) fgId = fg.Id;
        }
        catch (ElementGoneException) { }
        var entries = new List<(JsonObject Window, bool Foreground)>();
        foreach (var w in _scope.RunWindows(run, null))
        {
            try
            {
                var isFg = fgId is not null && w.Id == fgId;
                entries.Add((new JsonObject
                {
                    ["title"] = w.Name,
                    ["exe"] = _scope.ExeOf(w.ProcessId) ?? "",
                    ["automationId"] = w.AutomationId,
                    ["className"] = w.ClassName,
                    ["foreground"] = isFg,
                }, isFg));
            }
            catch (ElementGoneException) { }
        }
        var list = new JsonArray();
        foreach (var e in entries.Where(e => e.Foreground).Concat(entries.Where(e => !e.Foreground)).Take(MaxWindows)) list.Add(e.Window);
        return new JsonObject { ["windows"] = list };
    }

    /// <summary>Chords the Windows shell takes whatever has the focus: anything with Win, Ctrl+Esc, Ctrl+Shift+Esc,
    /// Alt+Tab, Alt+Shift+Tab, Alt+Esc. They start or switch to programs outside the policy.</summary>
    internal static bool IsSystemChord(KeyChord c) =>
        c.Win ||
        (c.Ctrl && c.Key == "Escape") ||
        (c.Alt && c.Key is "Tab" or "Escape");

    /// <summary>In repair mode the pointer must land on the target itself or an inert part of it (text, image, an unnamed
    /// container), never on a button or other control nested inside a list item.</summary>
    private static void CheckRepairReceiver(IUiNode receiver, IUiNode target)
    {
        var cur = receiver;
        for (var i = 0; i < 16 && cur is not null; i++)
        {
            if (cur.Id == target.Id) return;
            if (cur.ControlType is not ("Text" or "Image" or "Custom" or "Pane" or "Group"))
                throw RpcErrors.PolicyRefused($"in repair mode the click would land on a {cur.ControlType} inside the target");
            cur = cur.GetParent();
        }
        throw RpcErrors.PolicyRefused("in repair mode the click would land outside the target");
    }

    /// <summary>The keys that only move: Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Escape, no other modifier.</summary>
    internal static bool IsNavigationKey(KeyChord chord) =>
        !chord.Ctrl && !chord.Alt && !chord.Win &&
        (chord.Key == "Tab" || (!chord.Shift && chord.Key is "Up" or "Down" or "Left" or "Right" or "Home" or "End" or "PageUp" or "PageDown" or "Escape"));

    /// <summary>Whether any window of the run holds a declared write control (unreadable windows count as holding one).</summary>
    private bool RunHasWriteControl(RunState run)
    {
        if (_policy.WriteControls.Count == 0) return false;
        return _scope.RunWindows(run, null).Any(WindowHasWriteControl);
    }

    /// <summary>Whether the window or a descendant is a declared write control (an unreadable window counts as holding one).</summary>
    private bool WindowHasWriteControl(IUiNode window)
    {
        if (_policy.WriteControls.Count == 0) return false;
        try
        {
            var exe = _scope.ExeOf(window.ProcessId);
            foreach (var w in _policy.WriteControls)
            {
                if (!string.Equals(w.Exe, exe, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(window.AutomationId, w.AutomationId, StringComparison.Ordinal) ||
                    window.FindDescendants(new Cond(null, w.AutomationId, null, null, null)).Count > 0) return true;
            }
        }
        catch (ElementGoneException)
        {
            return true;
        }
        return false;
    }

    /// <summary>Whether a menu (a drop-down, a context menu, a Win32 popup menu) of the run is open.</summary>
    private bool RunMenuOpen(RunState run)
    {
        foreach (var window in _scope.RunWindows(run, null))
        {
            try
            {
                if (string.Equals(window.ControlType, "Menu", StringComparison.OrdinalIgnoreCase) || window.ClassName == "#32768") return true;
                if (window.FindDescendants(new Cond("Menu", null, null, null, null)).Any(m => !m.IsOffscreen)) return true;
            }
            catch (ElementGoneException)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>The run's focused element for a key without a target. Fails closed: when the focus cannot be told, it
    /// polls until the deadline and then refuses, instead of assuming the run's window.</summary>
    private Resolution FocusedResolution(RunState run, DateTimeOffset deadline, CancellationToken ct)
    {
        var window = _scope.CurrentWindow(run) ?? throw RpcErrors.NotFound("a window of the run", null);
        EnsureForeground(run, window);
        IUiNode? focused;
        while ((focused = _desktop.GetFocusedElement()) is null)
        {
            if (_time.GetUtcNow() >= deadline) throw RpcErrors.PolicyRefused("cannot tell which element has the keyboard focus");
            ct.ThrowIfCancellationRequested();
            Thread.Sleep(TargetResolver.PollInterval);
        }
        if (!_scope.IsRunProcess(run, focused.ProcessId))
            throw RpcErrors.PolicyRefused("the keyboard focus is in a window of another application");
        // The keyboard focus lives in the foreground window. UI Automation nests owned windows (dialogs, drop-downs)
        // under their owner, so the root of the focused element's tree may be the owner, not the window with the focus.
        var fg = _desktop.GetForegroundWindow();
        var top = fg is not null && _scope.IsRunProcess(run, fg.ProcessId) ? fg : _desktop.GetTopLevelWindowOf(focused) ?? window;
        return new Resolution(0, focused, top);
    }

    /// <summary>An action on a declared write control (the element or any ancestor inside its window) needs write: true,
    /// and is never allowed in repair mode.</summary>
    private void CheckWriteControl(IUiNode element, IUiNode window, bool write, ActMode mode, string what)
    {
        var cur = element;
        for (var i = 0; i < 64 && cur is not null; i++)
        {
            var exe = _scope.ExeOf(cur.ProcessId);
            if (_policy.IsWriteControl(exe, cur.AutomationId))
            {
                if (mode == ActMode.Repair) throw RpcErrors.PolicyRefused($"{what} is a declared write control; repair mode never acts on it");
                if (!write) throw RpcErrors.PolicyRefused($"{what} is a declared write control and needs write: true");
                return;
            }
            if (cur.Id == window.Id) return;
            cur = cur.GetParent();
        }
    }

    /// <summary>
    /// The foreground policy: if the foreground window is not one of the run's, bring the run's window forward (OS
    /// surfaces are ignored this way). If another application's window still holds the foreground, refuse.
    /// </summary>
    private void EnsureForeground(RunState run, IUiNode window)
    {
        var fg = _desktop.GetForegroundWindow();
        if (fg is not null && _scope.IsRunProcess(run, fg.ProcessId)) return;
        _desktop.BringToForeground(window);
        fg = _desktop.GetForegroundWindow();
        if (fg is null || _scope.IsRunProcess(run, fg.ProcessId) || _scope.IsOsSurface(fg)) return;
        throw RpcErrors.PolicyRefused($"a window of another application (\"{_scope.ExeOf(fg.ProcessId) ?? "unknown"}\") holds the foreground");
    }

    private JsonNode FileRetrieve(RunState run, Params p, CancellationToken ct)
    {
        var pattern = p.ReqString("pattern");
        var timeout = TimeSpan.FromMilliseconds(p.OptLong("timeoutMs", 0, MaxTimeoutMs) ?? DefaultFileTimeoutMs);
        var maxBytes = p.OptLong("maxBytes", 1, long.MaxValue) ?? _policy.MaxFileBytes;
        var limit = Math.Min(Math.Min(maxBytes, _policy.MaxFileBytes), RunnerPolicy.MaxFileBytesCeiling);
        var f = _files.Retrieve(run.ExportDir, pattern, timeout, limit, ct);
        _log.Info($"file.retrieve size={f.Size}");
        return new JsonObject { ["name"] = f.Name, ["size"] = f.Size, ["base64"] = Convert.ToBase64String(f.Bytes) };
    }

    private JsonNode Screenshot(RunState run, Params p, CancellationToken ct)
    {
        RequireSession();
        var window = _scope.CurrentWindow(run) ?? throw RpcErrors.NotFound("a window of the run", null);
        return new JsonObject { ["base64"] = Convert.ToBase64String(_desktop.CaptureWindowPng(window)) };
    }

    private TimeSpan Remaining(DateTimeOffset deadline)
    {
        var left = deadline - _time.GetUtcNow();
        return left < TimeSpan.Zero ? TimeSpan.Zero : left;
    }
}

/// <summary>Thrown by the driver when the action may succeed if retried (element disabled, busy). The message is fixed
/// text (never a value).</summary>
public sealed class RetryableActionException(string message) : Exception(message);

/// <summary>The segment typing model: segments are concatenated in order, export-directory markers filled with the
/// run's directory. Text segments are never interpreted.</summary>
public static class Segments
{
    public static string Compose(IReadOnlyList<Segment> segments, string exportDir)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var s in segments) sb.Append(s.ExportDir ? exportDir : s.Text);
        return sb.ToString();
    }
}
