using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Exceptions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;
using Rpa.Runner.Core;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Windows;

/// <summary>
/// The desktop over FlaUI (UI Automation 3). Actions prefer UI Automation patterns (Invoke, Value, Toggle,
/// SelectionItem, ExpandCollapse), which reach the element without moving the mouse or depending on focus; mouse and
/// keyboard input are the fallback, and before any real input the element that would receive it is passed to the
/// core's guard.
/// </summary>
public sealed class WindowsDesktop : IDesktop, IDisposable
{
    /// <summary>How long a pattern call may block before the runner assumes it opened a modal dialog and moves on.</summary>
    private static readonly TimeSpan ModalDetach = TimeSpan.FromMilliseconds(1500);

    private readonly UIA3Automation _automation = new();

    public WindowsDesktop()
    {
        // Physical pixels everywhere, so UI Automation's coordinates match the mouse's (PER_MONITOR_AWARE_V2 = -4).
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
    }

    public void Dispose() => _automation.Dispose();

    public SessionState GetSessionState()
    {
        var interactive = Environment.UserInteractive &&
                          Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out var session) && session != 0;
        var desk = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
        if (desk == IntPtr.Zero) return new SessionState(interactive, Locked: true, InputDesktopReachable: false);
        try
        {
            var sb = new StringBuilder(256);
            var name = Native.GetUserObjectInformation(desk, Native.UOI_NAME, sb, sb.Capacity * 2, out _) ? sb.ToString() : "";
            // "Default" is the user's desktop; "Winlogon" (lock screen) or the secure desktop means locked.
            return new SessionState(interactive, Locked: !string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase), InputDesktopReachable: true);
        }
        finally
        {
            Native.CloseDesktop(desk);
        }
    }

    public IReadOnlyList<IUiNode> GetTopLevelWindows()
    {
        var list = new List<IUiNode>();
        foreach (var h in Native.VisibleTopLevelWindows())
        {
            var n = Wrap(h);
            if (n is not null) list.Add(n);
        }
        return list;
    }

    public IUiNode? GetForegroundWindow()
    {
        var h = Native.GetForegroundWindow();
        return h == IntPtr.Zero ? null : (IUiNode?)Wrap(h) ?? new HwndNode(h);
    }

    public IUiNode? GetFocusedElement()
    {
        try { return new UiaNode(_automation, _automation.FocusedElement()); }
        catch (Exception e) when (e is COMException or ElementNotAvailableException) { return null; }
    }

    public IUiNode? GetTopLevelWindowOf(IUiNode element)
    {
        var root = _automation.GetDesktop();
        var walker = _automation.TreeWalkerFactory.GetControlViewWalker();
        var cur = ((UiaNode)element).Element;
        return UiaNode.Guard(() =>
        {
            for (var i = 0; i < 200; i++)
            {
                var parent = walker.GetParent(cur);
                if (parent is null || parent.Equals(root)) return new UiaNode(_automation, cur);
                cur = parent;
            }
            return (IUiNode?)null;
        });
    }

    public bool BringToForeground(IUiNode window)
    {
        var h = window is UiaNode u ? u.Handle : window is HwndNode hn ? hn.Handle : IntPtr.Zero;
        if (h == IntPtr.Zero) return false;
        if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_RESTORE);
        if (Native.SetForegroundWindow(h) && Native.GetForegroundWindow() == h) return true;
        // The usual workaround for the foreground lock: share input state with the current foreground thread.
        var fg = Native.GetForegroundWindow();
        var fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out _);
        var me = Native.GetCurrentThreadId();
        var attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
        try
        {
            Native.BringWindowToTop(h);
            Native.SetForegroundWindow(h);
        }
        finally
        {
            if (attached) Native.AttachThreadInput(me, fgThread, false);
        }
        if (Native.GetForegroundWindow() != h)
        {
            try { ((UiaNode)window).Element.Focus(); }
            catch (Exception e) when (e is COMException or ElementNotAvailableException or InvalidCastException) { }
        }
        return Native.GetForegroundWindow() == h;
    }

    public string? Perform(UiOperation op)
    {
        var node = (UiaNode)op.Element;
        var el = node.Element;
        if (op.Action is not (ActionKind.Read or ActionKind.Focus) && !node.IsEnabled)
            throw new RetryableActionException("the element is disabled");
        switch (op.Action)
        {
            case ActionKind.Click:
                Click(el, op);
                return null;
            case ActionKind.DoubleClick:
                MouseAt(el, op, Mouse.DoubleClick);
                return null;
            case ActionKind.Type:
                Type(node, op);
                return null;
            case ActionKind.Select:
                Select(el, op.Text!);
                return null;
            case ActionKind.Check:
            case ActionKind.Uncheck:
                SetChecked(el, op.Action == ActionKind.Check, op);
                return null;
            case ActionKind.Key:
                SendKey(el, op);
                return null;
            case ActionKind.Read:
                return Read(node);
            case ActionKind.Expand:
                Expand(el);
                return null;
            case ActionKind.Focus:
                UiaNode.Guard(() => el.Focus());
                return null;
            default:
                throw RpcErrors.InvalidParamsError("unknown action");
        }
    }

    private void Click(AutomationElement el, UiOperation op)
    {
        var ct = UiaNode.Guard(() => el.Properties.ControlType.ValueOrDefault);
        var p = el.Patterns;
        // A menu item with a submenu opens it; a leaf runs its command.
        if (ct is ControlType.MenuItem or ControlType.SplitButton && p.ExpandCollapse.IsSupported &&
            UiaNode.Guard(() => p.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault) == ExpandCollapseState.Collapsed)
        {
            Detached(() => p.ExpandCollapse.Pattern.Expand());
            return;
        }
        if (p.Invoke.IsSupported)
        {
            Detached(() => p.Invoke.Pattern.Invoke());
            return;
        }
        if (ct is ControlType.ListItem or ControlType.TabItem or ControlType.TreeItem or ControlType.DataItem && p.SelectionItem.IsSupported)
        {
            Detached(() => p.SelectionItem.Pattern.Select());
            return;
        }
        if (ct is ControlType.CheckBox or ControlType.RadioButton && p.Toggle.IsSupported)
        {
            Detached(() => p.Toggle.Pattern.Toggle());
            return;
        }
        MouseAt(el, op, Mouse.Click);
    }

    private void MouseAt(AutomationElement el, UiOperation op, Action<Point, MouseButton> click)
    {
        var point = UiaNode.Guard(() => el.TryGetClickablePoint(out var pt) ? pt : Center(el.BoundingRectangle));
        AutomationElement receiver;
        try { receiver = _automation.FromPoint(point); }
        catch (Exception e) when (e is COMException or ElementNotAvailableException)
        {
            throw new RetryableActionException("nothing to click at the element's position");
        }
        op.Guard(new UiaNode(_automation, receiver));
        click(point, MouseButton.Left);
    }

    private void Type(UiaNode node, UiOperation op)
    {
        var el = node.Element;
        var text = op.Text ?? "";
        var value = el.Patterns.Value;
        if (value.IsSupported && !UiaNode.Guard(() => value.Pattern.IsReadOnly.ValueOrDefault))
        {
            try
            {
                UiaNode.Guard(() => value.Pattern.SetValue(text));
                return;
            }
            catch (Exception e) when (e is COMException or InvalidOperationException or UnauthorizedAccessException)
            {
                // Some password fields refuse SetValue; fall back to the keyboard.
            }
        }
        // Keyboard: control characters would act as keys (Enter could press a default button), so they are refused.
        if (text.Any(char.IsControl))
            throw RpcErrors.PolicyRefused("typed text for this field contains control characters; use a key action instead");
        UiaNode.Guard(() => el.Focus());
        op.Guard(FocusedOr(node));
        Keyboard.TypeSimultaneously(VirtualKeyShort.CONTROL, (VirtualKeyShort)'A');
        Keyboard.Type(VirtualKeyShort.DELETE);
        if (text.Length > 0) Keyboard.Type(text);
        Wait.UntilInputIsProcessed();
    }

    private void Select(AutomationElement el, string itemName)
    {
        var p = el.Patterns;
        var expanded = false;
        if (p.ExpandCollapse.IsSupported)
        {
            Detached(() => p.ExpandCollapse.Pattern.Expand());
            expanded = true;
        }
        try
        {
            var cf = _automation.ConditionFactory;
            var item = UiaNode.Guard(() => el.FindFirst(TreeScope.Descendants,
                cf.ByName(itemName).And(cf.ByControlType(ControlType.ListItem).Or(cf.ByControlType(ControlType.TreeItem)).Or(cf.ByControlType(ControlType.MenuItem)))));
            if (item is not null && item.Patterns.SelectionItem.IsSupported)
            {
                Detached(() => item.Patterns.SelectionItem.Pattern.Select());
                return;
            }
            if (p.Value.IsSupported && !UiaNode.Guard(() => p.Value.Pattern.IsReadOnly.ValueOrDefault))
            {
                UiaNode.Guard(() => p.Value.Pattern.SetValue(itemName));
                return;
            }
            // Never echo the requested item: it came from the step.
            throw new RetryableActionException("the list has no item with the requested name");
        }
        finally
        {
            if (expanded)
            {
                try { p.ExpandCollapse.Pattern.Collapse(); }
                catch (Exception e) when (e is COMException or ElementNotAvailableException or InvalidOperationException) { }
            }
        }
    }

    private void SetChecked(AutomationElement el, bool on, UiOperation op)
    {
        var p = el.Patterns;
        if (p.Toggle.IsSupported)
        {
            for (var i = 0; i < 3; i++)
            {
                var state = UiaNode.Guard(() => p.Toggle.Pattern.ToggleState.ValueOrDefault);
                if ((state == ToggleState.On) == on) return;
                Detached(() => p.Toggle.Pattern.Toggle());
            }
            throw new RetryableActionException("the element did not reach the requested state");
        }
        if (on && p.SelectionItem.IsSupported)
        {
            if (!UiaNode.Guard(() => p.SelectionItem.Pattern.IsSelected.ValueOrDefault)) Detached(() => p.SelectionItem.Pattern.Select());
            return;
        }
        throw RpcErrors.InvalidParamsError("the element cannot be checked or unchecked");
    }

    private void SendKey(AutomationElement el, UiOperation op)
    {
        UiaNode.Guard(() => el.Focus());
        op.Guard(FocusedOr(new UiaNode(_automation, el)));
        Keyboard.TypeSimultaneously(Keys(op.Key!));
        Wait.UntilInputIsProcessed();
    }

    private static string Read(UiaNode node)
    {
        var v = node.Value;
        return string.IsNullOrEmpty(v) ? node.Name : v;
    }

    private static void Expand(AutomationElement el)
    {
        var p = el.Patterns;
        if (p.ExpandCollapse.IsSupported)
        {
            Detached(() => p.ExpandCollapse.Pattern.Expand());
            return;
        }
        throw RpcErrors.InvalidParamsError("the element cannot expand");
    }

    private IUiNode FocusedOr(IUiNode fallback) => GetFocusedElement() ?? fallback;

    /// <summary>
    /// Runs a pattern call that may open a modal dialog. In-process UI Automation providers (WinForms) answer only
    /// when the dialog closes, so after <see cref="ModalDetach"/> the call is left to finish in the background.
    /// </summary>
    private static void Detached(Action action)
    {
        var task = Task.Run(() =>
        {
            try { action(); }
            catch (ElementNotAvailableException) { /* the element went away because of the action (a closed form) */ }
            catch (COMException e) when (e.HResult == unchecked((int)0x80040201)) { }
        });
        try
        {
            if (!task.Wait(ModalDetach)) return;
        }
        catch (AggregateException e) when (e.InnerException is not null)
        {
            if (e.InnerException is InvalidOperationException or COMException)
                throw new RetryableActionException("the element refused the action");
            throw e.InnerException;
        }
    }

    private static VirtualKeyShort[] Keys(KeyChord chord)
    {
        var keys = new List<VirtualKeyShort>();
        if (chord.Ctrl) keys.Add((VirtualKeyShort)0x11);
        if (chord.Alt) keys.Add((VirtualKeyShort)0x12);
        if (chord.Shift) keys.Add((VirtualKeyShort)0x10);
        if (chord.Win) keys.Add((VirtualKeyShort)0x5B);
        keys.Add((VirtualKeyShort)(chord.Key switch
        {
            "Enter" => 0x0D, "Tab" => 0x09, "Escape" => 0x1B, "Space" => 0x20, "Backspace" => 0x08,
            "Delete" => 0x2E, "Insert" => 0x2D, "Home" => 0x24, "End" => 0x23, "PageUp" => 0x21, "PageDown" => 0x22,
            "Left" => 0x25, "Up" => 0x26, "Right" => 0x27, "Down" => 0x28, "Apps" => 0x5D,
            var f when f.Length > 1 && f[0] == 'F' => 0x70 + int.Parse(f.AsSpan(1), System.Globalization.CultureInfo.InvariantCulture) - 1,
            var c => (int)c[0],
        }));
        return keys.ToArray();
    }

    public byte[] CaptureWindowPng(IUiNode window)
    {
        var h = window is UiaNode u ? u.Handle : window is HwndNode hn ? hn.Handle : IntPtr.Zero;
        if (h == IntPtr.Zero || !Native.GetWindowRect(h, out var r)) throw RpcErrors.NotFound("a window to capture", null);
        var width = Math.Max(1, r.Right - r.Left);
        var height = Math.Max(1, r.Bottom - r.Top);
        using var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try { Native.PrintWindow(h, hdc, Native.PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }
        }
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    private static Point Center(Rectangle r) => new(r.Left + r.Width / 2, r.Top + r.Height / 2);

    private UiaNode? Wrap(IntPtr h)
    {
        try { return new UiaNode(_automation, _automation.FromHandle(h)); }
        catch (Exception e) when (e is COMException or ElementNotAvailableException or ArgumentException) { return null; }
    }
}
