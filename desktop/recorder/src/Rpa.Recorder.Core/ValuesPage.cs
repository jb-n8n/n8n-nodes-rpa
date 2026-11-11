namespace Rpa.Recorder.Core;

/// <summary>What a step on the values page is: a value as it was recorded, which the person may tick; a value made a
/// variable on the bar while recording (ticked, and its name can change); or a secret (ticked for good, shown by its
/// variable's name only).</summary>
public enum ValueKind { Recorded, Variable, Secret }

/// <summary>
/// One step on the values page: its position in the steps (<see cref="Index"/>; its number on the bar is
/// <see cref="Number"/>), its sentence as the list says it, whether it is ticked as changing from run to run, and the
/// variable name it gets. Change it with <see cref="WithTick"/> and <see cref="WithName"/>, which keep a secret a secret
/// and a variable a variable.
/// </summary>
public sealed record ValueRow(int Index, RecordedStep Step, ValueKind Kind, string Text, bool Ticked, string Name)
{
    public int Number => Index + 1;

    /// <summary>Only a value as recorded can be ticked and unticked: a secret's value is gone, and the recorder does not
    /// take a variable back to its recorded value.</summary>
    public bool CanUntick => Kind == ValueKind.Recorded;

    /// <summary>The name box is for a ticked value that is not a secret.</summary>
    public bool NameEditable => Ticked && Kind != ValueKind.Secret;

    public ValueRow WithTick(bool ticked) => CanUntick && ticked != Ticked ? this with { Ticked = ticked } : this;

    public ValueRow WithName(string name) => Kind != ValueKind.Secret && name != Name ? this with { Name = name } : this;
}

/// <summary>
/// The page the bar shows after Finish, before the name and Save: "Which of these change from run to run?", with every
/// step that typed a value or chose an item. Each ticked value becomes a run variable, as Make variable… makes it: its
/// recorded value is kept beside it as its start value (<see cref="Session.MarkVariable"/>), never for a secret. A
/// secret shows its variable's name, never a value.
/// </summary>
public static class ValuesPage
{
    public const string Question = "Which of these change from run to run?";
    /// <summary>The page's accessible name: without one, Windows names it after a label near it.</summary>
    public const string AreaName = "Values that can change";
    public const string Intro = "Tick each value that changes from run to run. n8n can then set it on each run, and it starts as recorded here.";
    public const string NameLabel = "Variable name";
    public const string Continue = "Continue";
    public const string Back = "Back";

    /// <summary>The line under a secret, in place of a name box.</summary>
    public static string SecretNote(ValueRow row) =>
        $"A secret: the typed value is not in the recording. On each run n8n supplies {row.Name} from an RPA Secret Variables credential.";

    /// <summary>Why a tick cannot be taken off (null when it can).</summary>
    public static string? Tip(ValueRow row) => row.Kind switch
    {
        ValueKind.Variable => "Made a variable while recording, so it stays one. Its name can change below.",
        ValueKind.Secret => "A secret stays a secret: its typed value is not in the recording.",
        _ => null,
    };

    /// <summary>A typed value or a chosen item, except a file name typed into a Save dialog (it stays as recorded: the run
    /// saves into its own export folder).</summary>
    public static bool Offers(RecordedStep step) => step.Kind is StepKind.Fill or StepKind.Select && step.ExportFile is null;

    /// <summary>
    /// The page's rows for these steps. A value as recorded starts unticked, with a name from its field's label; when
    /// another row, a variable or a secret has that name already, it gets <c>_2</c>, <c>_3</c> and so on. The choices
    /// in <paramref name="previous"/> (the page before Back) stay with the steps they were made for.
    /// </summary>
    public static IReadOnlyList<ValueRow> Rows(IReadOnlyList<RecordedStep> steps, IReadOnlyList<ValueRow>? previous = null)
    {
        previous ??= [];
        var rows = new List<ValueRow>();
        for (var i = 0; i < steps.Count; i++)
        {
            var step = steps[i];
            if (!Offers(step)) continue;
            var variable = StepText.VariableOf(step);
            var kind = step.Secret && variable is not null ? ValueKind.Secret : variable is not null ? ValueKind.Variable : ValueKind.Recorded;
            var before = previous.FirstOrDefault(p => ReferenceEquals(p.Step, step));
            var name = kind == ValueKind.Secret ? variable! : before?.Name ?? variable;
            rows.Add(new ValueRow(i, step, kind, StepText.Action(step), kind != ValueKind.Recorded || before?.Ticked == true, name ?? ""));
        }
        var taken = rows.Where(r => r.Name.Length > 0).Select(r => r.Name).ToHashSet(StringComparer.Ordinal);
        for (var i = 0; i < rows.Count; i++)
        {
            if (rows[i].Name.Length > 0) continue;
            var suggested = StepText.SuggestedName(rows[i].Step);
            var name = suggested;
            for (var n = 2; taken.Contains(name); n++) name = $"{suggested}_{n}";
            taken.Add(name);
            rows[i] = rows[i] with { Name = name };
        }
        return rows;
    }

    /// <summary>What is wrong with the name of a ticked value, with its step's number, or null when Continue can apply
    /// the page. Names are checked as the variable question checks them; two values may share a name (one variable).</summary>
    public static string? Problem(IEnumerable<ValueRow> rows) =>
        rows.Where(r => r.NameEditable).Select(r => DialogText.NameProblem(r.Name, []) is { } problem ? $"Step {r.Number}: {problem}" : null)
            .FirstOrDefault(p => p is not null);

    /// <summary>What Continue does: each ticked value as recorded becomes a variable of its name, and a variable whose
    /// name was changed gets the new one. Nothing else changes.</summary>
    public static IReadOnlyList<(int Index, string Name)> Changes(IEnumerable<ValueRow> rows) =>
        rows.Where(r => r.NameEditable && (r.Kind == ValueKind.Recorded || r.Name.Trim() != StepText.VariableOf(r.Step)))
            .Select(r => (r.Index, r.Name.Trim()))
            .ToArray();

    /// <summary>Applies <see cref="Changes"/> to the session, with its own checks (<see cref="Session.MarkVariable"/>).</summary>
    public static void Apply(Session session, IEnumerable<ValueRow> rows)
    {
        foreach (var (index, name) in Changes(rows)) session.MarkVariable(index, name);
    }
}
