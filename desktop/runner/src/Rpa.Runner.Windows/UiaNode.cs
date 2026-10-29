using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Exceptions;
using FlaUI.UIA3;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Windows;

/// <summary>An <see cref="IUiNode"/> over a FlaUI element. Every UI Automation failure that means "the element is gone"
/// becomes <see cref="ElementGoneException"/>, which the core retries.</summary>
internal sealed class UiaNode : IUiNode
{
    private readonly UIA3Automation _automation;
    private string? _id;

    public UiaNode(UIA3Automation automation, AutomationElement element)
    {
        _automation = automation;
        Element = element;
    }

    public AutomationElement Element { get; }

    public string Id => _id ??= Guard(() =>
    {
        var rid = Element.Properties.RuntimeId.ValueOrDefault;
        return rid is { Length: > 0 } ? string.Join('.', rid) : "h" + Element.Properties.NativeWindowHandle.ValueOrDefault;
    });

    public string ControlType => Guard(() => Element.Properties.ControlType.ValueOrDefault.ToString());
    public string Name => Guard(() => Element.Properties.Name.ValueOrDefault ?? "");
    public string AutomationId => Guard(() => Element.Properties.AutomationId.ValueOrDefault ?? "");
    public string ClassName => Guard(() => Element.Properties.ClassName.ValueOrDefault ?? "");
    public bool IsEnabled => Guard(() => Element.Properties.IsEnabled.ValueOrDefault);
    public bool IsOffscreen => Guard(() => Element.Properties.IsOffscreen.ValueOrDefault);
    public bool IsPassword => Guard(() => Element.Properties.IsPassword.ValueOrDefault);
    public int ProcessId => Guard(() => Element.Properties.ProcessId.ValueOrDefault);
    public IntPtr Handle => Guard(() => Element.Properties.NativeWindowHandle.ValueOrDefault);

    public string? Value => Guard(() =>
    {
        if (!Element.Patterns.Value.IsSupported) return null;
        try { return Element.Patterns.Value.Pattern.Value.ValueOrDefault; }
        catch (Exception e) when (e is COMException or PropertyNotSupportedException or UnauthorizedAccessException) { return null; }
    });

    public IReadOnlyList<IUiNode> GetChildren() => Guard(() =>
    {
        var walker = _automation.TreeWalkerFactory.GetControlViewWalker();
        var list = new List<IUiNode>();
        var child = walker.GetFirstChild(Element);
        while (child is not null && list.Count < 5000)
        {
            list.Add(new UiaNode(_automation, child));
            child = walker.GetNextSibling(child);
        }
        return (IReadOnlyList<IUiNode>)list;
    });

    public IUiNode? GetParent() => Guard(() =>
    {
        var p = _automation.TreeWalkerFactory.GetControlViewWalker().GetParent(Element);
        return p is null ? null : (IUiNode)new UiaNode(_automation, p);
    });

    public IReadOnlyList<IUiNode> FindDescendants(Cond cond) => Guard(() =>
    {
        var cf = _automation.ConditionFactory;
        var parts = new List<ConditionBase>();
        if (cond.ControlType is not null)
        {
            if (!Enum.TryParse<ControlType>(cond.ControlType, ignoreCase: true, out var ct) || !Enum.IsDefined(ct))
                return (IReadOnlyList<IUiNode>)[];
            parts.Add(cf.ByControlType(ct));
        }
        if (cond.AutomationId is not null) parts.Add(cf.ByAutomationId(cond.AutomationId));
        if (cond.Name is not null) parts.Add(cf.ByName(cond.Name));
        if (cond.ClassName is not null) parts.Add(cf.ByClassName(cond.ClassName));
        // The control view, like the tree walker GetChildren and GetParent use.
        parts.Add(new PropertyCondition(_automation.PropertyLibrary.Element.IsControlElement, true));
        ConditionBase condition = new AndCondition(parts.ToArray());
        return Element.FindAll(TreeScope.Descendants, condition).Select(e => (IUiNode)new UiaNode(_automation, e)).ToList();
    });

    public override string ToString() => $"{ControlType} \"{AutomationId}\"";

    internal static T Guard<T>(Func<T> read)
    {
        try { return read(); }
        catch (ElementNotAvailableException e) { throw new ElementGoneException("element not available", e); }
        catch (COMException e) when (IsGone(e)) { throw new ElementGoneException("element not available", e); }
    }

    internal static void Guard(Action act) => Guard(() =>
    {
        act();
        return 0;
    });

    // UIA_E_ELEMENTNOTAVAILABLE, UIA_E_NOTSUPPORTED on a dead element, RPC failures when the app exited.
    private static bool IsGone(COMException e) =>
        e.HResult is unchecked((int)0x80040201) or unchecked((int)0x800706BA) or unchecked((int)0x800706BE) or unchecked((int)0x80010108);
}

/// <summary>A window known only by its handle (UI Automation could not wrap it): enough for the foreground policy.</summary>
internal sealed class HwndNode(IntPtr hwnd) : IUiNode
{
    public string Id => "h" + hwnd;
    public string ControlType => "Window";
    public string Name => Native.TitleOf(hwnd);
    public string AutomationId => "";
    public string ClassName => Native.ClassOf(hwnd);
    public bool IsEnabled => true;
    public bool IsOffscreen => false;
    public bool IsPassword => false;
    public int ProcessId => Native.PidOf(hwnd);
    public string? Value => null;
    public IntPtr Handle => hwnd;
    public IReadOnlyList<IUiNode> GetChildren() => [];
    public IUiNode? GetParent() => null;
    public IReadOnlyList<IUiNode> FindDescendants(Cond cond) => [];
}
