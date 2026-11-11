using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core;

/// <summary>A step as the recorder's bar lists it: one plain sentence. A secret fill shows its variable, never a value.</summary>
public static partial class StepText
{
    private const int MaxShown = 60;

    /// <summary>The step's sentence, with a note when the person should check how it finds its element.</summary>
    public static string Sentence(RecordedStep step)
    {
        var sentence = Plain(step);
        if (step.Positional) sentence += " (found by its row position: check it)";
        else if (step.FoundByText) sentence += " (found by the text it shows now: check it)";
        return sentence;
    }

    /// <summary>
    /// The step's sentence without the note to check it (the bar's list shows that note as a mark). A read says what
    /// the person pointed at, <paramref name="seen"/> (the text the element showed when F9 was pressed, cut to one line
    /// of at most 40 characters), when there was one: <c>Read "6 line items" as out_result_count</c>. That is the bar's
    /// sentence only; the file names the element by its id, as <see cref="Sentence"/> does.
    /// </summary>
    public static string Action(RecordedStep step, string? seen = null) =>
        step.Kind == StepKind.Read && Notices.Short(seen ?? "").Trim() is { Length: > 0 } text ? $"Read \"{text}\" as {step.As}" : Plain(step);

    private static string Plain(RecordedStep step) => step.Kind switch
    {
        StepKind.Launch => $"Start {step.Exe}",
        StepKind.Scope => $"Wait for the window {step.Label}",
        StepKind.Click => $"{(step.Double ? "Double-click" : "Click")} {step.Label}",
        StepKind.Fill when step.ExportFile is not null => $"Save {step.ExportFile} into the run's export folder ({step.Label})",
        StepKind.Fill => $"Type {Shown(step.Value!, step.Secret)} into {step.Label}",
        StepKind.Select => $"Choose {Shown(step.Option!, false)} in {step.Label}",
        StepKind.Check => $"{(step.Checked ? "Check" : "Uncheck")} {step.Label}",
        StepKind.Key => $"Press {step.Chord} in {step.Label}",
        StepKind.Read => $"Read {step.Label} as {step.As}",
        _ => step.Label,
    };

    /// <summary>What a fill or a select does, for a question that names its step: <c>types "clerk" into User name</c>,
    /// <c>chooses "2000" in Company code</c>.</summary>
    public static string Describe(RecordedStep step)
    {
        switch (step.Kind)
        {
            case StepKind.Fill when step.ExportFile is not null: return $"saves {step.ExportFile} into the run's export folder";
            case StepKind.Fill: return $"types {Shown(step.Value!, step.Secret)} into {step.Label}";
            case StepKind.Select: return $"chooses {Shown(step.Option!, false)} in {step.Label}";
            default:
                var action = Plain(step);
                return action.Length == 0 ? action : char.ToLowerInvariant(action[0]) + action[1..];
        }
    }

    /// <summary>The run variable a fill's value or a select's item is, or null when it holds what was recorded.</summary>
    public static string? VariableOf(RecordedStep step) =>
        (step.Kind switch { StepKind.Fill => step.Value, StepKind.Select => step.Option, _ => null }) is { } value && IsVariable(value) ? value[6..^2] : null;

    /// <summary>A variable name for the step's value, from its element's label (Date from gives <c>date_from</c>).</summary>
    public static string SuggestedName(RecordedStep step) => SecretRules.VariableName(new ElementFacts("", "", step.Label, "", false, false, "", []));

    // The short prefixes programmers put before a control's name (lblResultCount, txtTotal): without them, the name says
    // what the control holds.
    private static readonly string[] ControlPrefixes = ["lbl", "txt", "tb", "btn", "cbo", "cmb", "cb", "chk", "lst", "lb", "lv", "grd", "dgv", "rb", "rdo", "num", "nud", "dtp", "lnk"];

    [GeneratedRegex("(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")] private static partial Regex WordStart();

    /// <summary>A run output name for a read of the element: <c>out_</c> and its stable id in words (lblResultCount gives
    /// <c>out_result_count</c>), else its control type in words. Never from the text it shows, which is the value read.</summary>
    public static string SuggestedReadName(ElementFacts element)
    {
        var words = WordStart().Replace(LocatorRules.ReadLabel(element), " ").Split([' ', '_', '-', '.'], StringSplitOptions.RemoveEmptyEntries).ToList();
        if (words.Count > 1 && ControlPrefixes.Contains(words[0].ToLowerInvariant())) words.RemoveAt(0);
        return "out_" + SecretRules.VariableName(new ElementFacts("", "", string.Join(' ', words), "", false, false, "", []));
    }

    private static bool IsVariable(string value) => value.StartsWith("{{var.", StringComparison.Ordinal) && value.EndsWith("}}", StringComparison.Ordinal);

    private static string Shown(string value, bool secret)
    {
        if (IsVariable(value)) return $"the {(secret ? "secret" : "variable")} {value[6..^2]}";
        return $"\"{(value.Length > MaxShown ? value[..(MaxShown - 3)] + "..." : value)}\"";
    }
}
