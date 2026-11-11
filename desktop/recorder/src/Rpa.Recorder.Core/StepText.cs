namespace Rpa.Recorder.Core;

/// <summary>A step as the recorder's bar lists it: one plain sentence. A secret fill shows its variable, never a value.</summary>
public static class StepText
{
    private const int MaxShown = 60;

    public static string Sentence(RecordedStep step)
    {
        var sentence = step.Kind switch
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
        return step.Positional ? sentence + " (found by its row position: check it)" : sentence;
    }

    /// <summary>A variable name for the step's value, from its element's label (Date from gives <c>date_from</c>).</summary>
    public static string SuggestedName(RecordedStep step) => SecretRules.VariableName(new ElementFacts("", "", step.Label, "", false, false, "", []));

    private static string Shown(string value, bool secret)
    {
        if (value.StartsWith("{{var.", StringComparison.Ordinal) && value.EndsWith("}}", StringComparison.Ordinal))
            return $"the {(secret ? "secret" : "variable")} {value[6..^2]}";
        return $"\"{(value.Length > MaxShown ? value[..(MaxShown - 3)] + "..." : value)}\"";
    }
}
