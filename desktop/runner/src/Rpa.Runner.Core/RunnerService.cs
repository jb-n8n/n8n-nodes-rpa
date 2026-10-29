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
    private const long DefaultActTimeoutMs = 10000;
    private const long DefaultFileTimeoutMs = 30000;

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

    public JsonNode Invoke(string method, Params p, CancellationToken ct) => method switch
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
        if (entry.Sha256 is not null)
        {
            using var f = File.OpenRead(path);
            if (!string.Equals(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(f)), entry.Sha256, StringComparison.Ordinal))
                throw RpcErrors.PolicyRefused($"\"{entry.Exe}\" does not match the sha256 the policy pins");
        }
        var pid = _processes.Start(path, app.Args);
        run.AddProcess(pid);
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
        if (mode == ActMode.Repair && action is not (ActionKind.Focus or ActionKind.Expand or ActionKind.Read or ActionKind.Click))
            throw RpcErrors.PolicyRefused("repair mode allows only focus, expand, read, and click on tabs, list items and tree items");
        if (chord is not null && _policy.IsGatedKey(chord))
        {
            if (mode == ActMode.Repair) throw RpcErrors.PolicyRefused($"the gated key {chord} is never allowed in repair mode");
            if (!write) throw RpcErrors.PolicyRefused($"the gated key {chord} needs write: true");
        }

        RequireSession();
        var res = target is null ? FocusedResolution(run) : _resolver.Resolve(run, target, Remaining(deadline), ct);
        var element = res.Element;
        var what = target?.Describe() ?? "the focused element";

        CheckWriteControl(element, res.Window, write, mode, "the target");
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
                res = target is null ? FocusedResolution(run) : _resolver.Resolve(run, target, Remaining(deadline), ct);
                element = res.Element;
                CheckWriteControl(element, res.Window, write, mode, "the target");
            }
        }
    }

    /// <summary>The keys that only move: Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Escape, no other modifier.</summary>
    internal static bool IsNavigationKey(KeyChord chord) =>
        !chord.Ctrl && !chord.Alt && !chord.Win &&
        (chord.Key == "Tab" || (!chord.Shift && chord.Key is "Up" or "Down" or "Left" or "Right" or "Home" or "End" or "PageUp" or "PageDown" or "Escape"));

    /// <summary>Whether any window of the run holds a declared write control (unreadable windows count as holding one).</summary>
    private bool RunHasWriteControl(RunState run)
    {
        if (_policy.WriteControls.Count == 0) return false;
        foreach (var window in _scope.RunWindows(run, null))
        {
            var exe = _scope.ExeOf(window.ProcessId);
            foreach (var w in _policy.WriteControls)
            {
                if (!string.Equals(w.Exe, exe, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    if (string.Equals(window.AutomationId, w.AutomationId, StringComparison.Ordinal) ||
                        window.FindDescendants(new Cond(null, w.AutomationId, null, null, null)).Count > 0) return true;
                }
                catch (ElementGoneException)
                {
                    return true;
                }
            }
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

    private Resolution FocusedResolution(RunState run)
    {
        var window = _scope.CurrentWindow(run) ?? throw RpcErrors.NotFound("a window of the run", null);
        EnsureForeground(run, window);
        var focused = _desktop.GetFocusedElement() ?? window;
        if (!_scope.IsRunProcess(run, focused.ProcessId))
            throw RpcErrors.PolicyRefused("the keyboard focus is in a window of another application");
        return new Resolution(0, focused, _desktop.GetTopLevelWindowOf(focused) ?? window);
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
        var limit = Math.Min(maxBytes, _policy.MaxFileBytes);
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
