using System.Collections.Concurrent;
using System.Drawing;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>An element as UI Automation described it, with the live element and the native window handles of the
/// element and its ancestors (<c>Handles[0]</c> is the element's, <c>Handles[i]</c> that of <c>Ancestors[i - 1]</c>;
/// zero where there is none).</summary>
internal sealed record Described(ElementFacts Facts, AutomationElement Element, uint ProcessId, IReadOnlyList<IntPtr> Handles);

/// <summary>
/// The one thread that owns UI Automation (MTA, as UI Automation clients should be), running jobs in the order they
/// came. The helpers below are called from those jobs only.
/// </summary>
internal sealed class UiaWorker : IDisposable
{
    private readonly BlockingCollection<Action> _jobs = [];
    private readonly Thread _thread;
    private UIA3Automation _automation = null!;
    private ConditionFactory _conditions = null!;
    private FlaUI.Core.ITreeWalker _walker = null!;

    public UiaWorker()
    {
        using var ready = new ManualResetEventSlim(false);
        _thread = new Thread(() => Loop(ready)) { IsBackground = true, Name = "ui-automation" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
        ready.Wait(TimeSpan.FromSeconds(30));
    }

    /// <summary>Queues a job; the task ends when it has run. A job's own failure is caught: the input goes on regardless.</summary>
    public Task Post(Action job)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            _jobs.Add(() =>
            {
                try { job(); }
                catch (Exception) { /* an element that went away or refused: the step is not recorded */ }
                finally { done.TrySetResult(); }
            });
        }
        catch (InvalidOperationException) { done.TrySetResult(); }
        return done.Task;
    }

    public void Dispose()
    {
        _jobs.CompleteAdding();
        _thread.Join(TimeSpan.FromSeconds(5));
    }

    private void Loop(ManualResetEventSlim ready)
    {
        _automation = new UIA3Automation();
        _conditions = _automation.ConditionFactory;
        _walker = _automation.TreeWalkerFactory.GetControlViewWalker();
        ready.Set();
        foreach (var job in _jobs.GetConsumingEnumerable()) job();
        _automation.Dispose();
    }

    /// <summary>The element at a screen point, with its ancestors.</summary>
    public Described? At(int x, int y)
    {
        var element = _automation.FromPoint(new Point(x, y));
        return element is null ? null : Describe(element, withAncestors: true);
    }

    /// <summary>The element that has the keyboard focus, with its ancestors (they tell a common file dialog's file-name box).</summary>
    public Described? Focused()
    {
        var element = Safe(() => _automation.FocusedElement());
        return element is null ? null : Describe(element, withAncestors: true);
    }

    /// <summary>
    /// The file-name box of the Save dialog <paramref name="dialog"/> (<see cref="FileDialogs.IsFileNameBox"/>): among the
    /// dialog's child windows, an Edit with control id 1001, described with its ancestors. Its text is not read here.
    /// </summary>
    public Described? FileNameBox(IntPtr dialog, WindowFacts window)
    {
        foreach (var hwnd in Native.ChildWindows(dialog))
        {
            if (Native.GetDlgCtrlID(hwnd) != FileDialogs.NameBoxId || Native.ClassOf(hwnd) != "Edit") continue;
            var element = Safe(() => _automation.FromHandle(hwnd));
            if (element is null) continue;
            var d = Describe(element, withAncestors: true);
            if (FileDialogs.IsFileNameBox(window, d.Facts)) return d;
        }
        return null;
    }

    private Described Describe(AutomationElement element, bool withAncestors)
    {
        var ancestors = new List<ElementFacts>();
        var handles = new List<IntPtr> { Handle(element) };
        if (withAncestors)
        {
            var current = element;
            for (var i = 0; i < 40; i++)
            {
                var parent = Safe(() => _walker.GetParent(current));
                if (parent is null || Safe(() => _walker.GetParent(parent)) is null) break; // the parent is the desktop
                ancestors.Add(Facts(parent, []));
                handles.Add(Handle(parent));
                current = parent;
            }
        }
        var facts = Facts(element, ancestors) with
        {
            HasEditChild = Safe(() => element.Properties.ControlType.ValueOrDefault) == ControlType.ComboBox
                && Safe(() => element.FindFirstChild(_conditions.ByControlType(ControlType.Edit))) is not null,
            IsChecked = Safe(() => element.Patterns.Toggle.PatternOrDefault?.ToggleState.ValueOrDefault) switch
            {
                ToggleState.On => true,
                ToggleState.Off => false,
                _ => null,
            },
        };
        return new Described(facts, element, (uint)Safe(() => element.Properties.ProcessId.ValueOrDefault), handles);
    }

    private static ElementFacts Facts(AutomationElement element, IReadOnlyList<ElementFacts> ancestors)
    {
        var p = element.Properties;
        var runtimeId = Safe(() => p.RuntimeId.ValueOrDefault);
        return new ElementFacts(
            Safe(() => p.ControlType.ValueOrDefault).ToString(),
            Safe(() => p.AutomationId.ValueOrDefault) ?? "",
            Safe(() => p.Name.ValueOrDefault) ?? "",
            Safe(() => p.ClassName.ValueOrDefault) ?? "",
            SecretRules.PasswordFlag(ReadFlag(() => p.IsPassword.ValueOrDefault)),
            false,
            runtimeId is { Length: > 0 } ? string.Join(".", runtimeId) : "",
            ancestors);
    }

    private static IntPtr Handle(AutomationElement element) => Safe(() => element.Properties.NativeWindowHandle.ValueOrDefault);

    /// <summary>
    /// The top-level window a step finds its element in: the root window of the element's (or its nearest ancestor's)
    /// native window; for a ListItem of an open drop-down list, that of the ComboBox that owns the list.
    /// </summary>
    public static WindowFacts WindowOf(Described d, IntPtr fallback)
    {
        var from = 0;
        if (d.Facts.ControlType == "ListItem")
        {
            var combo = d.Facts.Ancestors.ToList().FindIndex(a => a.ControlType == "ComboBox");
            if (combo >= 0) from = combo + 1;
        }
        var hwnd = d.Handles.Skip(from).FirstOrDefault(h => h != IntPtr.Zero);
        if (hwnd == IntPtr.Zero) hwnd = fallback;
        return Window(Native.GetAncestor(hwnd, Native.GA_ROOT));
    }

    /// <summary>A top-level window's program file name (in lower case), title and class.</summary>
    public static WindowFacts Window(IntPtr root) =>
        new(ExeOf(Native.ProcessOf(root)), Native.TitleOf(root), Native.ClassOf(root));

    public static string ExeOf(uint processId) => Path.GetFileName(Native.ImagePath(processId) ?? "").ToLowerInvariant();

    /// <summary>
    /// How many distinct elements the condition finds in the windows the step would look in (UI Automation also shows
    /// an open menu under the window that owns it, so the same element can be reached twice).
    /// </summary>
    public int CountMatches(WindowFacts window, RecordedCondition condition, uint processId)
    {
        var recorded = WindowRules.Window(window);
        ConditionBase? find = null;
        if (condition.ControlType is { } type && Enum.TryParse<ControlType>(type, out var controlType)) find = _conditions.ByControlType(controlType);
        if (condition.AutomationId is { } id) find = find is null ? _conditions.ByAutomationId(id) : find.And(_conditions.ByAutomationId(id));
        if (condition.Name is { } name) find = find is null ? _conditions.ByName(name) : find.And(_conditions.ByName(name));
        if (find is null) return 0;
        var seen = new HashSet<string>();
        foreach (var hwnd in Native.TopLevelWindows())
        {
            var pid = Native.ProcessOf(hwnd);
            if (recorded.Exe is { } exe ? !string.Equals(ExeOf(pid), exe, StringComparison.OrdinalIgnoreCase) : pid != processId) continue;
            if (recorded.Title is { } title && Native.TitleOf(hwnd) != title) continue;
            if (recorded.ClassName is { } cls && Native.ClassOf(hwnd) != cls) continue;
            var root = Safe(() => _automation.FromHandle(hwnd));
            foreach (var found in Safe(() => root?.FindAllDescendants(find)) ?? [])
                seen.Add(Safe(() => found.Properties.RuntimeId.ValueOrDefault) is { Length: > 0 } rid ? string.Join(".", rid) : Guid.NewGuid().ToString());
        }
        return seen.Count;
    }

    /// <summary>The password flag of the live element; null when it cannot be read.</summary>
    public static bool? ReadPasswordFlag(AutomationElement field) => ReadFlag(() => field.Properties.IsPassword.ValueOrDefault);

    private static bool? ReadFlag(Func<bool> read)
    {
        try { return read(); }
        catch (Exception) { return null; }
    }

    /// <summary>A text field's text, read through its value pattern.</summary>
    public static string? ReadValue(AutomationElement field) => Safe(() => field.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault);

    /// <summary>A drop-down list's selected item.</summary>
    public static string? ReadSelection(AutomationElement list)
    {
        var selected = Safe(() => list.Patterns.Selection.PatternOrDefault?.Selection.ValueOrDefault);
        return selected is { Length: > 0 } ? Safe(() => selected[0].Properties.Name.ValueOrDefault) : null;
    }

    private static T? Safe<T>(Func<T> read)
    {
        try { return read(); }
        catch (Exception) { return default; }
    }
}
