using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Ui;

/// <summary>
/// One UI element (or top-level window) as the runner sees it. Implemented over UI Automation on Windows and by a
/// fake in the tests. Property reads may cross process boundaries, so callers read only what they need.
/// </summary>
public interface IUiNode
{
    /// <summary>Identity for de-duplication within one call (UI Automation's runtime id).</summary>
    string Id { get; }

    string ControlType { get; }
    string Name { get; }
    string AutomationId { get; }
    string ClassName { get; }
    bool IsEnabled { get; }
    bool IsOffscreen { get; }
    bool IsPassword { get; }

    /// <summary>The id of the process that owns the element.</summary>
    int ProcessId { get; }

    /// <summary>The value (UI Automation ValuePattern), or null when the element has none.</summary>
    string? Value { get; }

    IReadOnlyList<IUiNode> GetChildren();

    IUiNode? GetParent();

    /// <summary>
    /// All descendants (not the node itself) matching the condition's properties (its <c>Index</c> is ignored here),
    /// in document order. Implementations may search natively; the default walks <see cref="GetChildren"/>.
    /// </summary>
    IReadOnlyList<IUiNode> FindDescendants(Cond cond);
}

/// <summary>Session health as Windows reports it.</summary>
public sealed record SessionState(bool Interactive, bool Locked, bool InputDesktopReachable)
{
    public bool Usable => Interactive && !Locked && InputDesktopReachable;

    public string Problem() =>
        !Interactive ? "the runner's session is not interactive"
        : Locked ? "the workstation is locked"
        : !InputDesktopReachable ? "the input desktop is unreachable (session disconnected or a secure desktop is shown)"
        : "none";
}

/// <summary>Called by the driver on the element that would really receive mouse or keyboard input, before sending it.
/// Throws <see cref="RpcException"/> to refuse.</summary>
public delegate void InputGuard(IUiNode receiver);

/// <summary>One action for the driver to perform on a resolved element.</summary>
public sealed record UiOperation(
    IUiNode Element,
    IUiNode Window,
    ActionKind Action,
    string? Text,
    KeyChord? Key,
    TimeSpan Timeout,
    InputGuard Guard);

/// <summary>The desktop: windows, focus, input and capture. Windows implements it over FlaUI (UIA3).</summary>
public interface IDesktop
{
    SessionState GetSessionState();

    /// <summary>Top-level windows of every process, front to back.</summary>
    IReadOnlyList<IUiNode> GetTopLevelWindows();

    /// <summary>The foreground window, or null when there is none.</summary>
    IUiNode? GetForegroundWindow();

    /// <summary>The element with the keyboard focus, or null.</summary>
    IUiNode? GetFocusedElement();

    /// <summary>The top-level window that contains the element.</summary>
    IUiNode? GetTopLevelWindowOf(IUiNode element);

    /// <summary>The window that owns a top-level window (Win32 GW_OWNER), or null when it has none or it cannot be told.</summary>
    IUiNode? GetOwnerWindow(IUiNode window);

    /// <summary>Brings a top-level window to the foreground; true when it is the foreground window afterwards.</summary>
    bool BringToForeground(IUiNode window);

    /// <summary>Performs the operation; returns text for <c>read</c>, else null.</summary>
    string? Perform(UiOperation op);

    /// <summary>A PNG of one window (its own pixels, not what overlaps it).</summary>
    byte[] CaptureWindowPng(IUiNode window);
}

/// <summary>Starts, inspects and stops processes. The default implementation uses System.Diagnostics.Process.</summary>
public interface IProcessHost
{
    /// <summary>Starts the executable (no shell) and returns its process id.</summary>
    int Start(string exePath, IReadOnlyList<string> args);

    /// <summary>The executable's file name ("ErpDemo.exe"), or null when the process is gone.</summary>
    string? GetExeName(int pid);

    /// <summary>The executable's full path, or null when the process is gone or cannot be inspected.</summary>
    string? GetExePath(int pid);

    /// <summary>The parent process id, or null when unknown.</summary>
    int? GetParentPid(int pid);

    /// <summary>
    /// True when the process descends from one of the roots (processes this host started). Windows answers from the
    /// job object each launched process was placed in; elsewhere parent links count only when the parent started
    /// before the child, so a reused process id cannot pose as a parent.
    /// </summary>
    bool IsDescendantOf(int pid, IReadOnlyCollection<int> roots);

    /// <summary>Kills the process and its descendants; ignores processes that already exited.</summary>
    void KillTree(int pid);
}

/// <summary>
/// Fail-closed choice of the element that will receive keyboard input. Drivers call it right before typing or sending
/// a key, with what the window manager reports (independent of a busy UI Automation provider) and what UI Automation
/// reports; anything unknown or inconsistent is a retryable failure, never a guess.
/// </summary>
public static class KeyboardFocusCheck
{
    /// <param name="foregroundKnown">The window manager reports a foreground window.</param>
    /// <param name="foregroundIsExpected">That foreground window is the run window the element lives in.</param>
    /// <param name="focusPid">The process owning the window with the keyboard focus (window manager).</param>
    /// <param name="focused">The element UI Automation reports as focused, or null when it cannot tell.</param>
    public static IUiNode Receiver(bool foregroundKnown, bool foregroundIsExpected, int focusPid, IUiNode? focused)
    {
        if (!foregroundKnown) throw new RetryableActionException("cannot tell which window has the keyboard focus");
        if (!foregroundIsExpected) throw new RetryableActionException("the run's window does not have the keyboard focus");
        if (focused is null) throw new RetryableActionException("cannot tell which element has the keyboard focus");
        if (focused.ProcessId != focusPid) throw new RetryableActionException("the keyboard focus moved while checking it");
        return focused;
    }
}
