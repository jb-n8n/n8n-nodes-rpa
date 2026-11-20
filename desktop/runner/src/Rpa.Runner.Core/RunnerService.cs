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

    /// <summary>The longest clipboard text clipboard.read returns; longer text is refused, never cut.</summary>
    public const int MaxClipboardChars = 1000;

    /// <summary>How long clipboard.read waits for another application to let go of the clipboard.</summary>
    private static readonly TimeSpan ClipboardWait = TimeSpan.FromSeconds(2);

    /// <summary>clipboard.read is allowed only this long after the run's most recent act.</summary>
    public static readonly TimeSpan ClipboardFreshness = TimeSpan.FromSeconds(10);
    private const long DefaultActTimeoutMs = 10000;
    private const long DefaultFileTimeoutMs = 30000;

    private const string RepairRefusal =
        "repair mode allows only expand, read, Escape without a target, and click on tabs, list items and tree items";

    private const string ProbeRefusal = "probe mode allows only click and doubleClick";

    /// <summary>The most probe acts one run may make (a repair's retargeted and added steps, or a proof's).</summary>
    public const int MaxProbesPerRun = 12;

    private static readonly HashSet<string> RepairClickable = new(StringComparer.OrdinalIgnoreCase) { "TabItem", "ListItem", "TreeItem" };

    private static readonly HashSet<string> ProbeClickable = new(StringComparer.OrdinalIgnoreCase)
        { "Button", "MenuItem", "Hyperlink", "SplitButton", "TabItem", "ListItem", "TreeItem" };

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
        "look" => WithRun(p, ct, Look),
        "clipboard.read" => WithRun(p, ct, ClipboardRead),
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
        // A reservation: the next run.begin within reserveMs must carry reserveFor (the proof of a repair takes the runner
        // again without another run starting in between); any other run id is busy until then.
        var reserveFor = p.OptString("reserveFor");
        var reserveMs = p.OptLong("reserveMs", 1000, RunManager.MaxReserveMs);
        if ((reserveFor is null) != (reserveMs is null)) throw RpcErrors.InvalidParamsError("reserveFor and reserveMs go together");
        if (reserveFor is not null && (reserveFor.Length == 0 || reserveFor.Length > 200)) throw RpcErrors.InvalidParamsError("reserveFor must be 1 to 200 characters");
        _runs.End(p.OptString("runId"), reserveFor, reserveMs);
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
        // Every act, before anything else: clipboard.read later needs the clipboard to have changed since this mark
        // (the act's own copy), and the act to have finished at most ClipboardFreshness ago.
        var mark = new ActMark(_desktop.GetClipboardSequenceNumber(), _time.GetUtcNow());
        run.LastAct = mark;
        try
        {
            return ActOnce(run, p, ct);
        }
        finally
        {
            run.LastAct = mark with { At = _time.GetUtcNow() };
        }
    }

    private JsonNode ActOnce(RunState run, Params p, CancellationToken ct)
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

        // Floor checks that need no UI. Repair mode never moves the focus (G3): a focus change fires the app's
        // Leave/Validating handlers, which some apps use to save.
        if (mode == ActMode.Repair && action is not (ActionKind.Expand or ActionKind.Read or ActionKind.Click or ActionKind.Key))
            throw RpcErrors.PolicyRefused(RepairRefusal);
        if (mode == ActMode.Probe)
        {
            // Clicks only: an inserted or retargeted step that types, selects or checks waits for approval.
            if (action is not (ActionKind.Click or ActionKind.DoubleClick)) throw RpcErrors.PolicyRefused(ProbeRefusal);
            if (write) throw RpcErrors.PolicyRefused("probe mode never sends a write step (write is not allowed with it)");
            if (run.Probes >= MaxProbesPerRun) throw RpcErrors.PolicyRefused($"a run may make at most {MaxProbesPerRun} probe acts");
        }
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

        CheckTarget(run, element, res.Window, action, write, mode);
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
        if (mode == ActMode.Probe) run.Probes++;

        void Guard(IUiNode receiver)
        {
            if (!_scope.IsRunProcess(run, receiver.ProcessId))
                throw RpcErrors.PolicyRefused("the input would reach a window of another application");
            CheckWriteControl(receiver, res.Window, write, mode, "the element under the pointer or with the keyboard focus");
            // Where the pointer lands; a repair-mode key (Escape) goes to the focused element, which is its target.
            if (mode == ActMode.Repair && action != ActionKind.Key) CheckRepairReceiver(receiver, element);
            if (mode == ActMode.Probe && action is ActionKind.Click or ActionKind.DoubleClick) CheckRepairReceiver(receiver, element);
            // Right before the key goes out: the popup menu that allowed a repair-mode Escape may have closed.
            if (mode == ActMode.Repair && action == ActionKind.Key) CheckRepairEscape(run, res.Window);
        }

        while (true)
        {
            try
            {
                // Before the text goes out: a field that took even part of it is covered in AI repair's picture.
                if (action == ActionKind.Type) run.NoteTyped(element.ProcessId, element.Id, element.ControlType, element.AutomationId, text!);
                var outText = _desktop.Perform(new UiOperation(element, res.Window, action, text, chord, Remaining(deadline), Guard));
                _log.Info($"act {action} candidate={res.Candidate}{(write ? " write" : "")}{(mode == ActMode.Repair ? " repair" : mode == ActMode.Probe ? " probe" : "")}");
                var o = new JsonObject();
                if (action == ActionKind.Read) o["text"] = outText ?? "";
                return o;
            }
            catch (RetryableActionException e)
            {
                if (_time.GetUtcNow() >= deadline) throw e.ElementDisabled ? RpcErrors.Disabled(target) : RpcErrors.Timeout($"{e.Message} ({what})");
                ct.ThrowIfCancellationRequested();
                Thread.Sleep(TargetResolver.PollInterval);
            }
            catch (ElementGoneException)
            {
                if (_time.GetUtcNow() >= deadline) throw RpcErrors.Timeout($"the element went away while acting on it ({what})");
                Thread.Sleep(TargetResolver.PollInterval);
                res = target is null ? FocusedResolution(run, deadline, ct) : _resolver.Resolve(run, target, Remaining(deadline), ct);
                element = res.Element;
                // The element that came back gets every check the first one got.
                CheckTarget(run, element, res.Window, action, write, mode);
            }
        }
    }

    /// <summary>Every per-element check of an act, in order: the write control, then the mode's own (repair: Escape,
    /// clickable types, write words, combo items; probe: CheckProbe). Run after the first resolve and after every
    /// re-resolve, so an element that comes back after it went away is checked the same way.</summary>
    private void CheckTarget(RunState run, IUiNode element, IUiNode window, ActionKind action, bool write, ActMode mode)
    {
        CheckWriteControl(element, window, write, mode, "the target");
        if (mode == ActMode.Repair)
        {
            if (action == ActionKind.Key) CheckRepairEscape(run, window);
            if (action == ActionKind.Click && !RepairClickable.Contains(element.ControlType))
                throw RpcErrors.PolicyRefused($"repair mode may click only tabs, list items and tree items, not a {element.ControlType}");
            if (action is ActionKind.Click or ActionKind.Expand)
            {
                // G4: nothing that reads like a write is expanded or selected in repair mode, declared or not.
                if (ReadsLikeWrite(element))
                    throw RpcErrors.PolicyRefused("the target's name or automation id reads like a write (save, post, submit, confirm, ok and the like); repair mode never acts on it");
                // Nor anything on the destructive deny list: a tab, list item or menu named so may act when it is
                // selected or opened.
                if (ReadsDestructive(element))
                    throw RpcErrors.PolicyRefused("the target's name or automation id reads like it deletes, cancels, rejects or signs out; repair mode never acts on it");
                // G2: choosing an item of a combo box changes a form value.
                if (action == ActionKind.Click && InComboBox(element, window))
                    throw RpcErrors.PolicyRefused("repair mode never chooses an item of a combo box: that changes a form value");
            }
        }
        if (mode == ActMode.Probe) CheckProbe(element, window, action);
    }

    /// <summary>Escape fires a form's cancel button (WinForms CancelButton, a Win32 dialog's IDCANCEL) whatever has the
    /// focus, and a cancel button may discard or cancel something whether or not the policy declares it. So in repair mode
    /// Escape is allowed only while a popup menu of that window is open: then it only closes the menu (G1).</summary>
    private void CheckRepairEscape(RunState run, IUiNode window)
    {
        if (!PopupMenuOpenFor(run, window))
            throw RpcErrors.PolicyRefused("in repair mode Escape could press a cancel button of this window, so it is allowed only while a menu is open");
    }

    /// <summary>Whether the element's name or automation id has a write word (<see cref="WriteWords"/>).</summary>
    private static bool ReadsLikeWrite(IUiNode element) => WriteWords.Has(element.Name) || WriteWords.Has(element.AutomationId);

    /// <summary>Whether the element's name or automation id is on the destructive deny list (<see cref="DestructiveWords"/>).</summary>
    private static bool ReadsDestructive(IUiNode element) => DestructiveWords.Has(element.Name) || DestructiveWords.Has(element.AutomationId);

    /// <summary>Whether the element is an item of a combo box: a ComboBox above it in its window, a Win32 combo list
    /// (class ComboLBox) above it, or the window itself is such a list. Fails closed: an element that goes away counts.</summary>
    private static bool InComboBox(IUiNode element, IUiNode window)
    {
        try
        {
            if (window.ClassName == "ComboLBox") return true;
            var cur = element.GetParent();
            for (var i = 0; i < 32 && cur is not null; i++)
            {
                if (string.Equals(cur.ControlType, "ComboBox", StringComparison.OrdinalIgnoreCase) || cur.ClassName == "ComboLBox") return true;
                if (cur.Id == window.Id) return false;
                cur = cur.GetParent();
            }
            return false;
        }
        catch (ElementGoneException)
        {
            return true;
        }
    }

    /// <summary>
    /// Probe mode (G5): a click AI repair added or retargeted acts once, before anyone approved its control, only when it
    /// cannot write as far as the runner can tell. Only clicks: a step that types, selects or checks waits for approval. Declared write controls are refused before this (CheckWriteControl).
    /// The target's name and automation id must have no write word (G4). A click must be on a button, menu item, link,
    /// tab, list item or tree item, never on a combo box item, and never in a window whose title or static text has a
    /// write word: a dialog's default button runs whatever the dialog says, so the dialog's words count (DR3).
    /// </summary>
    private static void CheckProbe(IUiNode element, IUiNode window, ActionKind action)
    {
        if (action is not (ActionKind.Click or ActionKind.DoubleClick)) throw RpcErrors.PolicyRefused(ProbeRefusal);
        if (ReadsLikeWrite(element))
            throw RpcErrors.PolicyRefused("the target's name or automation id reads like a write (save, post, submit, confirm, ok and the like); probe mode never acts on it");
        if (ReadsDestructive(element))
            throw RpcErrors.PolicyRefused("the target's name or automation id reads like it deletes, cancels, rejects or signs out; probe mode never acts on it");
        if (!ProbeClickable.Contains(element.ControlType))
            throw RpcErrors.PolicyRefused($"probe mode may click only buttons, menu items, links, tabs, list items and tree items, not a {element.ControlType}");
        if (InComboBox(element, window))
            throw RpcErrors.PolicyRefused("probe mode never chooses an item of a combo box");
        if (WindowReadsLikeWrite(window))
            throw RpcErrors.PolicyRefused("the window's title or text reads like a write (save, post, submit, confirm, ok and the like), so probe mode clicks nothing in it");
    }

    /// <summary>Whether a window's title or any of its static texts has a write word. Fails closed: an unreadable window counts.</summary>
    private static bool WindowReadsLikeWrite(IUiNode window)
    {
        try
        {
            return WriteWords.Has(window.Name) || window.FindDescendants(new Cond("Text", null, null, null, null)).Any(t => WriteWords.Has(t.Name));
        }
        catch (ElementGoneException)
        {
            return true;
        }
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
                if (mode == ActMode.Probe) throw RpcErrors.PolicyRefused($"{what} is a declared write control; probe mode never acts on it");
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

    /// <summary>The most masked texts a look takes, and the longest one.</summary>
    public const int MaxMaskTexts = 64;
    public const int MaxMaskTextLength = 4096;

    /// <summary>
    /// AI repair's look: the snapshot of a window (as <c>snapshot</c>) and, when it can be made, the masked, labelled picture
    /// of the run's windows (RepairPicture): node i of the snapshot is labelled <c>labelStart + i</c>. <c>mask</c> lists the
    /// texts whose controls are covered (the engine's typed variable values and clipboard texts); the runner also covers
    /// password and credential-like fields and every control the run typed into. When no picture can be made with every such control covered, the
    /// answer has <c>noPicture</c> with the reason instead, and the snapshot alone. The picture is never logged.
    /// </summary>
    private JsonNode Look(RunState run, Params p, CancellationToken ct)
    {
        var sel = p.OptWindow("window");
        var maxNodes = (int)(p.OptLong("maxNodes", 1, 5000) ?? DefaultMaxNodes);
        var maxDepth = (int)(p.OptLong("maxDepth", 1, 100) ?? DefaultMaxDepth);
        var labelStart = p.ReqLong("labelStart", 0, 1_000_000_000);
        var maxEdge = (int)(p.OptLong("maxEdge", 64, RepairPicture.MaxEdge) ?? RepairPicture.MaxEdge);
        var masks = MaskTexts(p);
        RequireSession();
        var window = _scope.CurrentWindow(run, sel)
                     ?? throw RpcErrors.NotFound(sel is null ? "a window of the run" : $"window {sel}", null);
        var sources = new List<IUiNode>();
        var result = SnapshotBuilder.Build(window, maxNodes, maxDepth, sources);
        var nodes = new JsonArray();
        foreach (var n in result.Nodes) nodes.Add(System.Text.Json.JsonSerializer.SerializeToNode(n));
        var o = new JsonObject
        {
            ["window"] = new JsonObject { ["title"] = window.Name, ["exe"] = _scope.ExeOf(window.ProcessId) ?? "" },
            ["nodes"] = nodes,
        };
        if (result.Truncated) o["truncated"] = true;
        var marks = sources.Select((e, i) => new RepairPicture.Mark(labelStart + i, e)).ToList();
        try
        {
            var pic = Picture(run, window, marks, masks, maxEdge, ct);
            o["picture"] = new JsonObject
            {
                ["mime"] = "image/png", ["base64"] = Convert.ToBase64String(pic.Png), ["width"] = pic.Width, ["height"] = pic.Height,
                ["masked"] = pic.Masked, ["labels"] = pic.Labels,
            };
            _log.Info($"look picture {pic.Width}x{pic.Height} masked={pic.Masked} labels={pic.Labels}");
        }
        catch (PictureRefusedException e)
        {
            o["noPicture"] = e.Message;
            _log.Info($"look no picture: {e.Message}");
        }
        return o;
    }

    private static IReadOnlyList<string> MaskTexts(Params p)
    {
        if (!p.Root.TryGetProperty("mask", out var v) || v.ValueKind == System.Text.Json.JsonValueKind.Null) return [];
        if (v.ValueKind != System.Text.Json.JsonValueKind.Array) throw RpcErrors.InvalidParamsError("mask must be an array of strings");
        var list = new List<string>();
        foreach (var e in v.EnumerateArray())
        {
            if (e.ValueKind != System.Text.Json.JsonValueKind.String) throw RpcErrors.InvalidParamsError("mask must be an array of strings");
            var t = e.GetString()!;
            if (t.Length > MaxMaskTextLength) throw RpcErrors.InvalidParamsError($"a mask text may be at most {MaxMaskTextLength} characters");
            list.Add(t);
        }
        if (list.Count > MaxMaskTexts) throw RpcErrors.InvalidParamsError($"mask may hold at most {MaxMaskTexts} texts");
        return list;
    }

    /// <summary>The picture, tried up to three times while the UI changes under it; then refused, never partly checked.</summary>
    private RepairPicture.Result Picture(RunState run, IUiNode shown, IReadOnlyList<RepairPicture.Mark> marks, IReadOnlyList<string> masks, int maxEdge, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var windows = _scope.RunWindows(run, null).Take(MaxWindows).ToList();
                // The engine's masked texts and the texts the run typed, each looked for in every control.
                var texts = masks.Concat(run.TypedTexts).ToList();
                return RepairPicture.Make(windows, shown, _desktop.CaptureWindow, _desktop.GetWindowRect, pid => _scope.IsRunProcess(run, pid),
                    run.WasTypedInto, texts, marks, maxEdge);
            }
            catch (ElementGoneException) when (attempt < 3)
            {
                ct.ThrowIfCancellationRequested();
                Thread.Sleep(TargetResolver.PollInterval);
            }
            catch (ElementGoneException)
            {
                throw new PictureRefusedException("the UI kept changing while the runner checked what to cover");
            }
        }
    }

    /// <summary>
    /// The clipboard's text, for an app whose value is only available through a Copy button (a desktop authenticator
    /// app). Off unless the policy sets clipboardRead, and only while one of the run's windows holds the foreground: the
    /// run never brings its window back for a read, since the text on the clipboard may then be another application's.
    /// The text must also be the run's own copy: a process of the run (helper processes included) owns the clipboard,
    /// its content changed since the run's most recent act, and that act finished at most
    /// <see cref="ClipboardFreshness"/> ago. So text another application or a person copied (a password) is never
    /// returned. The text is never logged and never put in an error. Longer than <see cref="MaxClipboardChars"/> is
    /// refused.
    /// </summary>
    private JsonNode ClipboardRead(RunState run, Params p, CancellationToken ct)
    {
        if (!_policy.ClipboardRead)
            throw RpcErrors.PolicyRefused("reading the clipboard is off in the runner's policy (clipboardRead)");
        RequireSession();
        var fg = _desktop.GetForegroundWindow();
        if (fg is null || !_scope.IsRunProcess(run, fg.ProcessId))
        {
            var holder = fg is null ? "no window" : $"a window of \"{_scope.ExeOf(fg.ProcessId) ?? "unknown"}\"";
            throw RpcErrors.PolicyRefused($"the clipboard is read only while a window of the run holds the foreground, and {holder} holds it");
        }
        var last = run.LastAct
            ?? throw RpcErrors.PolicyRefused("the clipboard is read only right after an act of the run copied to it, and the run has not acted yet");
        var age = _time.GetUtcNow() - last.At;
        if (age > ClipboardFreshness)
            throw RpcErrors.PolicyRefused($"the clipboard is read only within {ClipboardFreshness.TotalSeconds:0} seconds after the run's last act, and {Math.Floor(age.TotalSeconds):0} seconds have passed");

        // Runs while the clipboard is open, so the owner and the sequence number are those of the text read after it.
        void Check(ClipboardState state)
        {
            if (state.OwnerProcessId is not int owner)
                throw RpcErrors.PolicyRefused("the clipboard is read only when a process of the run put the text there, and no window owns the clipboard");
            if (!_scope.IsRunProcess(run, owner))
                throw RpcErrors.PolicyRefused($"the clipboard is read only when a process of the run put the text there, and a window of \"{_scope.ExeOf(owner) ?? "unknown"}\" owns it");
            if (state.SequenceNumber == last.ClipboardSequence)
                throw RpcErrors.PolicyRefused("the clipboard has not changed since the run's last act, so the text is not the run's copy");
        }

        var deadline = _time.GetUtcNow() + ClipboardWait;
        string? text;
        while (true)
        {
            try
            {
                text = _desktop.ReadClipboardText(MaxClipboardChars, Check);
                break;
            }
            catch (RetryableActionException e)
            {
                if (_time.GetUtcNow() >= deadline) throw RpcErrors.Timeout($"{e.Message} (clipboard.read)");
                ct.ThrowIfCancellationRequested();
                Thread.Sleep(TargetResolver.PollInterval);
            }
        }
        text ??= "";
        if (text.Length > MaxClipboardChars)
            throw RpcErrors.PolicyRefused($"the clipboard holds more than {MaxClipboardChars} characters");
        _log.Info($"clipboard.read chars={text.Length}");
        return new JsonObject { ["text"] = text };
    }

    private TimeSpan Remaining(DateTimeOffset deadline)
    {
        var left = deadline - _time.GetUtcNow();
        return left < TimeSpan.Zero ? TimeSpan.Zero : left;
    }
}

/// <summary>Thrown by the driver when the action may succeed if retried (element disabled, busy). The message is fixed
/// text (never a value).</summary>
public sealed class RetryableActionException(string message) : Exception(message)
{
    /// <summary>The app reports the element to UI Automation as not enabled; when the retries run out, the timeout
    /// says what to do instead (<see cref="RpcErrors.Disabled"/>).</summary>
    public bool ElementDisabled { get; private init; }

    /// <summary>The element the action targets is disabled (a read or a focus still works).</summary>
    public static RetryableActionException Disabled() => new("the element is disabled") { ElementDisabled = true };
}

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
