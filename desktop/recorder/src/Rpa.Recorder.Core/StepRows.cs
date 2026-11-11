namespace Rpa.Recorder.Core;

/// <summary>The small mark after a step on the bar: a variable, a secret, or a step to check.</summary>
public enum StepMark { None, Variable, Secret, Check }

/// <summary>A row of the bar's list: the step's number (the same in the list and in every question about it), its
/// sentence, its mark, and the tooltip that says why the mark is there (null without one).</summary>
public sealed record StepRow(int Number, string Text, StepMark Mark, string? Tip);

/// <summary>Which step actions fit the selected step, and the line that says what they act on.</summary>
public sealed record StepActions(bool Delete, bool Variable, bool Secret, string Hint);

/// <summary>The bar's step list: its rows, the actions that fit a step, and where it scrolls.</summary>
public static class StepRows
{
    public const string LateTip = "The app answered late, so this step was recorded as it was then. Check it, and delete it if it is wrong.";
    public const string PositionalTip = "It finds its element by its row position, so on a later run it acts on whatever is in that row. Check it.";
    public const string ByTextTip = "It finds its element by the text it shows now, so it may not find it once that text changes. Check it.";
    public const string LabelClickTip = "A click on a label usually does nothing. Delete this step if it was a mistake.";

    /// <param name="seen">What a read's element showed when it was added (null: nothing known).</param>
    public static IReadOnlyList<StepRow> Of(IReadOnlyList<(RecordedStep Step, bool Late)> steps, Func<RecordedStep, string?>? seen = null) =>
        steps.Select((s, i) => Row(i + 1, s.Step, s.Late, seen?.Invoke(s.Step))).ToArray();

    private static StepRow Row(int number, RecordedStep step, bool late, string? seen)
    {
        var checks = new List<string>();
        if (late) checks.Add(LateTip);
        if (step.Positional) checks.Add(PositionalTip);
        else if (step.FoundByText) checks.Add(ByTextTip);
        if (step.Kind == StepKind.Click && step.Target?.Path[^1].ControlType == "Text") checks.Add(LabelClickTip);

        var variable = StepText.VariableOf(step);
        string? valueTip = null;
        var mark = StepMark.None;
        if (step.Secret && variable is not null)
        {
            mark = StepMark.Secret;
            valueTip = $"The typed value is not in the recording. On each run the secret variable {variable} supplies it.";
        }
        else if (variable is not null)
        {
            mark = StepMark.Variable;
            valueTip = $"On each run this value comes from the variable {variable}, which n8n supplies.";
        }
        if (checks.Count > 0) mark = StepMark.Check;
        if (valueTip is not null) checks.Add(valueTip);
        return new StepRow(number, StepText.Action(step, seen), mark, checks.Count > 0 ? string.Join(' ', checks) : null);
    }

    public static string MarkText(StepMark mark) => mark switch
    {
        StepMark.Variable => "Variable",
        StepMark.Secret => "Secret",
        StepMark.Check => "Check",
        _ => "",
    };

    /// <summary>
    /// The actions that fit the selected step (null: none selected), numbered <paramref name="number"/>. Any step can
    /// be deleted. A typed value or a chosen item can be a variable; only a typed value can be a secret; a secret stays
    /// a secret; a file name typed into a Save dialog stays as recorded (the run saves into its own export folder).
    /// </summary>
    public static StepActions ActionsFor(RecordedStep? step, int number)
    {
        if (step is null) return new(false, false, false, "Select a step to change it.");
        if (step.Kind is not (StepKind.Fill or StepKind.Select)) return new(true, false, false, $"Step {number} has no value to make a variable or a secret.");
        if (step.Secret) return new(true, false, false, $"Step {number} is already a secret.");
        if (step.ExportFile is not null) return new(true, false, false, $"Step {number} saves a file into the run's export folder: its name stays as recorded.");
        return new(true, true, step.Kind == StepKind.Fill, $"Step {number} is selected.");
    }

    /// <summary>Whether closing or starting over loses work: there are steps, and they are not the ones last saved
    /// (<paramref name="saved"/>, null before the first save).</summary>
    public static bool Unsaved(IReadOnlyList<RecordedStep>? saved, IReadOnlyList<RecordedStep> now) =>
        now.Count > 0 && (saved is null || !saved.SequenceEqual(now));

    /// <summary>The first row to show so that the last row is in view: the rows from it to the end fit into
    /// <paramref name="visible"/> (the last row alone when it is higher than that).</summary>
    public static int TopIndexShowingLast(IReadOnlyList<int> heights, int visible)
    {
        var top = heights.Count - 1;
        if (top < 0) return 0;
        var used = heights[top];
        while (top > 0 && used + heights[top - 1] <= visible) used += heights[--top];
        return top;
    }

    /// <summary>Whether the list scrolls to the newest step: a step was added, or the newest one changed (a click into a
    /// field became the fill). An edit or a delete of a step leaves the list where the person is.</summary>
    public static bool NewestChanged(IReadOnlyList<RecordedStep> before, IReadOnlyList<RecordedStep> now) =>
        now.Count > before.Count || (now.Count == before.Count && now.Count > 0 && !now[^1].Equals(before[^1]));
}
