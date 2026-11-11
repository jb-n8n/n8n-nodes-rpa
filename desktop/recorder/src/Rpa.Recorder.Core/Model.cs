namespace Rpa.Recorder.Core;

/// <summary>
/// What UI Automation said about an element when the person acted on it. <c>RuntimeId</c> tells one element from
/// another while the recorder runs (it is never saved); <c>HasEditChild</c> is whether a ComboBox holds an Edit (an
/// editable ComboBox); <c>Ancestors</c> go from the nearest one up, without the desktop.
/// </summary>
public sealed record ElementFacts(string ControlType, string AutomationId, string Name, string ClassName, bool IsPassword,
    bool HasEditChild, string RuntimeId, IReadOnlyList<ElementFacts> Ancestors);

/// <summary>The top-level window an element is in: its program's file name, its title and its window class.</summary>
public sealed record WindowFacts(string Exe, string Title, string ClassName);

/// <summary>
/// What the Windows layer reports, in the order it happened. A field the person typed into is left (FieldLeft) before
/// the mouse-down or key that leaves it is reported.
/// </summary>
public abstract record Observation(DateTimeOffset At);

/// <summary>
/// A mouse button went down on <c>Element</c>. <c>Window</c> is the element's top-level window; for a ListItem of an
/// open drop-down list, the window of the ComboBox that owns the list. <c>Matches</c> is how many elements
/// <see cref="LocatorRules.Condition"/> of the element finds in that window (1 when it finds only this one).
/// </summary>
public sealed record MouseDown(DateTimeOffset At, WindowFacts Window, ElementFacts Element, int Matches) : Observation(At);

/// <summary>
/// A key went down while <c>Focused</c> had the focus. <c>Typing</c> is <see cref="KeyRules.IsTyping"/>: typing changes
/// the focused field and is never recorded as keys, and its <c>Chord</c> is empty. Otherwise <c>Chord</c> is the key
/// event in the canonical spelling (<see cref="KeyRules.Chord"/>).
/// </summary>
public sealed record KeyDown(DateTimeOffset At, WindowFacts Window, ElementFacts Focused, string Chord, bool Typing) : Observation(At);

/// <summary>
/// The person left a field: its text (<c>Value</c>) or, for a drop-down list, its selected item (<c>Selection</c>),
/// read before the input that left it was delivered. <c>Value</c> is null for a secret field
/// (<see cref="SecretRules.IsSecret"/>), which is never read.
/// </summary>
public sealed record FieldLeft(DateTimeOffset At, WindowFacts Window, ElementFacts Field, string? Value, string? Selection) : Observation(At);

/// <summary>The recorder started the application the person chose (<c>ExePath</c>, with <c>Args</c>) and it showed <c>Window</c>.</summary>
public sealed record AppStarted(DateTimeOffset At, string ExePath, IReadOnlyList<string> Args, WindowFacts Window) : Observation(At);

/// <summary>The kinds of event in a recording file. A scope is never a step: the file has one where the window changes.</summary>
public enum StepKind { Launch, Scope, Click, Fill, Select, Key, Read }

/// <summary>A window as a step finds it again (see <see cref="WindowRules"/>).</summary>
public sealed record RecordedWindow(string? Exe, string? Title, string? ClassName);

/// <summary>One condition of a locator's path. There is no index: an element is found by its id or its name.</summary>
public sealed record RecordedCondition(string? ControlType, string? AutomationId, string? Name);

/// <summary>A step's element: its window and the path to it, outermost condition first.</summary>
public sealed record RecordedTarget(RecordedWindow Window, IReadOnlyList<RecordedCondition> Path);

/// <summary>
/// One event of the recording: a step on the recorder's bar, or a scope in the file. <c>Value</c> is a fill's value
/// (one <c>{{var.name}}</c> when <c>Secret</c>), <c>Option</c> a select's item, <c>Chord</c> a key's chord, <c>As</c> a
/// read's output name. <c>Positional</c>: the element is found by a name that carries its row position.
/// </summary>
public sealed record RecordedStep(StepKind Kind, DateTimeOffset At, string Label)
{
    public RecordedTarget? Target { get; init; }
    /// <summary>A launch's or a scope's window.</summary>
    public RecordedWindow? Window { get; init; }
    /// <summary>A launch's program file name and arguments.</summary>
    public string? Exe { get; init; }
    public IReadOnlyList<string> Args { get; init; } = [];
    public string? Value { get; init; }
    /// <summary>The file a fill types into a Save dialog; its value is then <c>{{$exportDir}}\&lt;file&gt;</c>.</summary>
    public string? ExportFile { get; init; }
    public bool Secret { get; init; }
    public string? Option { get; init; }
    public string? Chord { get; init; }
    public string? As { get; init; }
    public bool Positional { get; init; }

    /// <summary>The runtime id of the element the step acts on, for folding a click into the step that follows it.</summary>
    internal string ElementId { get; init; } = "";
    /// <summary>When a click folded into this step happened, if that was before <c>At</c>.</summary>
    internal DateTimeOffset? FoldedAt { get; init; }
    /// <summary>When the person started this step: a window change before it is a scope at this time.</summary>
    internal DateTimeOffset StartedAt => FoldedAt is { } folded && folded < At ? folded : At;
}

/// <summary>The rules every text in a recording file follows, so the importer never refuses what the recorder saves.</summary>
internal static class Texts
{
    /// <summary>The longest text of a window, a condition or a label, as the importer allows.</summary>
    public const int MaxText = 500;

    /// <summary>The text when a window or a condition can match by it: not blank, one line, at most 500 characters, and
    /// no <c>{{</c> (the importer refuses a <c>{{$...}}</c> template anywhere, and a step would read <c>{{var.x}}</c> as
    /// a variable); null otherwise.</summary>
    public static string? Matchable(string? text) =>
        string.IsNullOrWhiteSpace(text) || text.Length > MaxText || text.Contains('\r') || text.Contains('\n') || text.Contains("{{")
            ? null
            : text;

    /// <summary>A label as the file holds it: at most 500 characters, with every <c>{{</c> broken up.</summary>
    public static string Label(string text)
    {
        while (text.Contains("{{")) text = text.Replace("{{", "{ {");
        return text.Length > MaxText ? text[..MaxText] : text;
    }
}
