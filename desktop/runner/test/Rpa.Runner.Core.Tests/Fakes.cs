using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core.Tests;

/// <summary>An element of the fake UI tree.</summary>
public sealed class FakeNode : IUiNode
{
    private static int _next;
    private readonly List<FakeNode> _children = [];

    public FakeNode(string controlType, string name = "", string automationId = "", int pid = 0)
    {
        _controlType = controlType;
        Name = name;
        AutomationId = automationId;
        ProcessId = pid;
        Id = "fake-" + Interlocked.Increment(ref _next);
    }

    public string Id { get; }
    private string _controlType;

    /// <summary>When set, reading the control type, class or offscreen state throws ElementGoneException.</summary>
    public bool Gone { get; set; }

    /// <summary>The Win32 owner window (a popup menu's or dialog's owner).</summary>
    public FakeNode? Owner { get; set; }

    /// <summary>When set, searching its subtree throws ElementGoneException (as the Windows driver's HwndNode does: a
    /// window UI Automation could not wrap).</summary>
    public bool Unreadable { get; set; }

    public string ControlType { get => Gone ? throw new ElementGoneException("gone") : _controlType; set => _controlType = value; }
    public string Name { get; set; }
    public string AutomationId { get; set; }
    private string _className = "";
    public string ClassName { get => Gone ? throw new ElementGoneException("gone") : _className; set => _className = value; }
    public bool IsEnabled { get; set; } = true;
    private bool _offscreen;
    public bool IsOffscreen { get => Gone ? throw new ElementGoneException("gone") : _offscreen; set => _offscreen = value; }
    public bool IsPassword { get; set; }
    public int ProcessId { get; set; }
    public string? Value { get; set; }
    public FakeNode? Parent { get; private set; }

    public FakeNode Add(FakeNode child)
    {
        child.Parent = this;
        child.Inherit(ProcessId);
        lock (_children) _children.Add(child);
        return this;
    }

    public FakeNode Child(string controlType, string name = "", string automationId = "", Action<FakeNode>? configure = null)
    {
        var c = new FakeNode(controlType, name, automationId, ProcessId);
        configure?.Invoke(c);
        Add(c);
        return this;
    }

    public FakeNode Find(string automationIdOrName) =>
        TargetResolver.WalkFind(this, new Cond(null, automationIdOrName, null, null, null)).Cast<FakeNode>().FirstOrDefault()
        ?? TargetResolver.WalkFind(this, new Cond(null, null, automationIdOrName, null, null)).Cast<FakeNode>().First();

    // A subtree built before it was attached takes its new parent's process.
    private void Inherit(int pid)
    {
        if (ProcessId != 0 || pid == 0) return;
        ProcessId = pid;
        lock (_children) foreach (var c in _children) c.Inherit(pid);
    }

    public IReadOnlyList<IUiNode> GetChildren()
    {
        lock (_children) return _children.ToArray();
    }
    public IUiNode? GetParent() => Parent;
    public IReadOnlyList<IUiNode> FindDescendants(Cond cond) => Unreadable ? throw new ElementGoneException("unreadable") : TargetResolver.WalkFind(this, cond);
    public override string ToString() => $"{ControlType} {AutomationId} {Name}";
}

/// <summary>A scripted desktop: windows front to back, a foreground window, and a log of performed operations.</summary>
public sealed class FakeDesktop : IDesktop
{
    public List<FakeNode> Windows { get; } = [];
    public FakeNode? Foreground { get; set; }
    public FakeNode? Focused { get; set; }
    public SessionState Session { get; set; } = new(true, false, true);
    public List<UiOperation> Performed { get; } = [];
    public bool CanBringToFront { get; set; } = true;

    /// <summary>When set, Perform calls the guard with this element (as if the mouse landed on it).</summary>
    public FakeNode? InputReceiver { get; set; }

    public Func<UiOperation, string?>? OnPerform { get; set; }

    /// <summary>Runs at the start of Perform, before any input guard (for example to close a menu right before the key).</summary>
    public Action<UiOperation>? BeforeInput { get; set; }

    public IUiNode? GetOwnerWindow(IUiNode window) => ((FakeNode)window).Owner;

    public SessionState GetSessionState() => Session;
    public IReadOnlyList<IUiNode> GetTopLevelWindows() => Windows;
    public IUiNode? GetForegroundWindow() => Foreground;
    public IUiNode? GetFocusedElement() => Focused;

    public IUiNode? GetTopLevelWindowOf(IUiNode element)
    {
        IUiNode? cur = element;
        while (cur?.GetParent() is { } p) cur = p;
        return cur;
    }

    public bool BringToForeground(IUiNode window)
    {
        if (CanBringToFront) Foreground = (FakeNode)window;
        return CanBringToFront;
    }

    /// <summary>Simulates UI Automation not knowing the focused element when the driver types or sends a key.</summary>
    public bool FocusUnknown { get; set; }

    public string? Perform(UiOperation op)
    {
        BeforeInput?.Invoke(op);
        if (op.Action is ActionKind.Type or ActionKind.Key)
        {
            // As the Windows driver does right before keyboard input: first the window manager's focus window (a bare
            // window handle, not the UI Automation element), then the focused element.
            op.Guard(new FakeNode("Window", "", "", (InputReceiver ?? op.Element).ProcessId));
            // The operation's window must be the foreground window.
            var expected = Foreground is null || Foreground.Id == op.Window.Id;
            var receiver = KeyboardFocusCheck.Receiver(true, expected, op.Element.ProcessId, FocusUnknown ? null : InputReceiver ?? op.Element);
            op.Guard(receiver);
        }
        else if (InputReceiver is not null) op.Guard(InputReceiver);
        Performed.Add(op);
        if (OnPerform is not null) return OnPerform(op);
        return op.Action == ActionKind.Read ? (op.Element.Value ?? op.Element.Name) : null;
    }

    public byte[] CaptureWindowPng(IUiNode window) => [0x89, 0x50, 0x4E, 0x47];

    /// <summary>The clipboard's Unicode text (null: no text on it). Setting it alone changes neither the owner nor the
    /// sequence number; <see cref="Copy"/> does what an application's copy does.</summary>
    public string? ClipboardText { get; set; }

    /// <summary>The process of the clipboard's owner window (null: no window owns it).</summary>
    public int? ClipboardOwnerPid { get; set; }

    /// <summary>GetClipboardSequenceNumber: every <see cref="Copy"/> adds one.</summary>
    public uint ClipboardSequence { get; set; } = 7;

    /// <summary>How many times the clipboard was opened (including opens that found it busy).</summary>
    public int ClipboardReads { get; private set; }

    /// <summary>How many times text was copied out of the open clipboard (after the check let it through).</summary>
    public int ClipboardTextReads { get; private set; }

    /// <summary>The next this many reads find the clipboard held by another application.</summary>
    public int ClipboardBusy { get; set; }

    /// <summary>An application's copy: new text, its owner window's process, and a new sequence number.</summary>
    public void Copy(string? text, int? ownerPid)
    {
        ClipboardText = text;
        ClipboardOwnerPid = ownerPid;
        ClipboardSequence++;
    }

    public uint GetClipboardSequenceNumber() => ClipboardSequence;

    public string? ReadClipboardText(int maxChars, Action<ClipboardState> check)
    {
        ClipboardReads++;
        if (ClipboardBusy > 0)
        {
            ClipboardBusy--;
            throw new RetryableActionException("another application holds the clipboard");
        }
        check(new ClipboardState(ClipboardOwnerPid, ClipboardSequence));
        ClipboardTextReads++;
        // As the Windows driver: at most maxChars + 1 characters, so the caller can tell the text is longer.
        return ClipboardText is null || ClipboardText.Length <= maxChars ? ClipboardText : ClipboardText[..(maxChars + 1)];
    }
}

/// <summary>Processes by id with fixed names; Start hands out new ids.</summary>
public sealed class FakeProcessHost : IProcessHost
{
    private int _nextPid = 1000;
    public Dictionary<int, string> Names { get; } = [];
    public Dictionary<int, string> Paths { get; } = [];
    public Dictionary<int, int> Parents { get; } = [];
    public List<int> Killed { get; } = [];
    public List<(string Path, IReadOnlyList<string> Args)> Started { get; } = [];

    /// <summary>The exe name the next Start reports for its process.</summary>
    public string NextName { get; set; } = "ErpDemo.exe";

    public int Start(string exePath, IReadOnlyList<string> args)
    {
        var pid = _nextPid++;
        Names[pid] = NextName;
        Paths[pid] = exePath;
        Started.Add((exePath, args));
        OnStart?.Invoke(pid);
        return pid;
    }

    /// <summary>Runs inside Start (for example to end the run while the app is starting).</summary>
    public Action<int>? OnStart { get; set; }

    public string? GetExeName(int pid) => Names.TryGetValue(pid, out var n) ? n : null;
    public string? GetExePath(int pid) => Paths.TryGetValue(pid, out var p) ? p : null;
    public int? GetParentPid(int pid) => Parents.TryGetValue(pid, out var p) ? p : null;

    public bool IsDescendantOf(int pid, IReadOnlyCollection<int> roots)
    {
        int? cur = pid;
        for (var i = 0; i < 16 && cur is int c; i++)
        {
            cur = GetParentPid(c);
            if (cur is int p && roots.Contains(p)) return true;
        }
        return false;
    }
    public void KillTree(int pid) => Killed.Add(pid);
}

/// <summary>Records private directories; the writable answer is set by the test.</summary>
public sealed class FakePathSecurity : IPathSecurity
{
    public List<string> Private { get; } = [];
    public bool Writable { get; set; }

    public void CreatePrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        Private.Add(Path.GetFullPath(path));
    }

    public bool IsWritableByRunnerUser(string file) => Writable;
}
