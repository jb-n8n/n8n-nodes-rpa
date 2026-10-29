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
        ControlType = controlType;
        Name = name;
        AutomationId = automationId;
        ProcessId = pid;
        Id = "fake-" + Interlocked.Increment(ref _next);
    }

    public string Id { get; }
    public string ControlType { get; set; }
    public string Name { get; set; }
    public string AutomationId { get; set; }
    public string ClassName { get; set; } = "";
    public bool IsEnabled { get; set; } = true;
    public bool IsOffscreen { get; set; }
    public bool IsPassword { get; set; }
    public int ProcessId { get; set; }
    public string? Value { get; set; }
    public FakeNode? Parent { get; private set; }

    public FakeNode Add(FakeNode child)
    {
        child.Parent = this;
        if (child.ProcessId == 0) child.ProcessId = ProcessId;
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

    public IReadOnlyList<IUiNode> GetChildren()
    {
        lock (_children) return _children.ToArray();
    }
    public IUiNode? GetParent() => Parent;
    public IReadOnlyList<IUiNode> FindDescendants(Cond cond) => TargetResolver.WalkFind(this, cond);
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
        if (op.Action is ActionKind.Type or ActionKind.Key)
        {
            // As the Windows driver does right before keyboard input.
            var receiver = KeyboardFocusCheck.Receiver(true, true, op.Element.ProcessId, FocusUnknown ? null : InputReceiver ?? op.Element);
            op.Guard(receiver);
        }
        else if (InputReceiver is not null) op.Guard(InputReceiver);
        Performed.Add(op);
        if (OnPerform is not null) return OnPerform(op);
        return op.Action == ActionKind.Read ? (op.Element.Value ?? op.Element.Name) : null;
    }

    public byte[] CaptureWindowPng(IUiNode window) => [0x89, 0x50, 0x4E, 0x47];
}

/// <summary>Processes by id with fixed names; Start hands out new ids.</summary>
public sealed class FakeProcessHost : IProcessHost
{
    private int _nextPid = 1000;
    public Dictionary<int, string> Names { get; } = [];
    public Dictionary<int, int> Parents { get; } = [];
    public List<int> Killed { get; } = [];
    public List<(string Path, IReadOnlyList<string> Args)> Started { get; } = [];

    /// <summary>The exe name the next Start reports for its process.</summary>
    public string NextName { get; set; } = "ErpDemo.exe";

    public int Start(string exePath, IReadOnlyList<string> args)
    {
        var pid = _nextPid++;
        Names[pid] = NextName;
        Started.Add((exePath, args));
        return pid;
    }

    public string? GetExeName(int pid) => Names.TryGetValue(pid, out var n) ? n : null;
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
