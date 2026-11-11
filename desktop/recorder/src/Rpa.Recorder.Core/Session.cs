namespace Rpa.Recorder.Core;

/// <summary>
/// One recording: the observations of the Windows layer in, in order, and the tidy steps out, as the recorder's bar
/// lists them and as the recording file holds them (with a scope wherever the window changes).
/// <list type="bullet">
/// <item>A field's text is <see cref="FieldLeft"/>'s value, read when the person leaves it, never rebuilt from keys. A
/// secret field's value is never kept: its fill is <c>{{var.name}}</c>, marked secret.</item>
/// <item>A click into a field that is then typed into folds into the fill; a click that opens a drop-down folds into
/// the select that follows. Tab and Shift+Tab fold away before a fill or a select.</item>
/// <item>A ListItem of a ComboBox's list is a select on the ComboBox with the item's text; a drop-down list chosen by
/// keys gives its selection when it is left.</item>
/// <item>A click on an element with a toggle state (a check box) is a check with the state the click sets, so a later
/// run that starts from the other state still ends where the person left it. A radio button stays a click (selecting
/// it twice changes nothing). Space on a focused check box, radio button or button (<see cref="Activated"/>) records
/// what a click on it records.</item>
/// <item>Two clicks on the same element within <see cref="DoubleClickMs"/> are one double-click.</item>
/// </list>
/// Not thread-safe: the Windows layer calls it from one thread at a time.
/// </summary>
public sealed class Session
{
    private readonly List<RecordedStep> _steps = [];
    private (string Exe, IReadOnlyList<string> Args)? _app;
    /// <summary>The field the person is typing into, until they leave it. Its value is never kept here.</summary>
    private Typing? _typing;

    private sealed record Typing(ElementFacts Field, WindowFacts Window, DateTimeOffset At, FieldKind Kind);

    /// <summary>What the bar shows; a step's index is its position.</summary>
    public IReadOnlyList<RecordedStep> Steps => _steps.ToArray();

    /// <summary>The system's double-click time: a second click on the same element within it makes the click a
    /// double-click. 0 (the default) folds no clicks.</summary>
    public int DoubleClickMs { get; init; }

    /// <summary>The field the person is typing into, until they leave it.</summary>
    public ElementFacts? FieldBeingTyped => _typing?.Field;

    /// <summary>
    /// The field that <paramref name="next"/> leaves, or null. The Windows layer asks before it adds a mouse-down or a
    /// key, and then adds that field's <see cref="FieldLeft"/> first, read before the input is delivered. A click inside
    /// the field (or on a part of it) and more typing into it do not leave it; a click elsewhere, a key event and typing
    /// into another element do.
    /// </summary>
    public ElementFacts? FieldLeftBy(Observation next)
    {
        if (_typing is not { } typing) return null;
        var field = typing.Field;
        return next switch
        {
            MouseDown m when Same(field, m.Element) || m.Element.Ancestors.Any(a => Same(field, a)) => null,
            KeyDown { Typing: true } k when Same(field, k.Focused) => null,
            _ => field,
        };
    }

    public void Add(Observation o)
    {
        switch (o)
        {
            case AppStarted started: Started(started); break;
            case MouseDown down: Clicked(down); break;
            case Activated activated: Activate(activated); break;
            case KeyDown key: Pressed(key); break;
            case FieldLeft left: Left(left); break;
            default: throw new ArgumentException($"unknown observation {o.GetType().Name}", nameof(o));
        }
    }

    private void Started(AppStarted o)
    {
        if (_app is not null) throw new InvalidOperationException("a recording records one application");
        var exe = WindowRules.FileName(o.ExePath);
        if (!WindowRules.IsExeName(exe)) throw new ArgumentException("the application must be a program (.exe)", nameof(o));
        if (o.Args.Any(a => a.Contains("{{"))) throw new ArgumentException("the application's arguments may not hold {{", nameof(o));
        var args = o.Args.ToArray();
        _app = (exe, args);
        _steps.Add(new RecordedStep(StepKind.Launch, o.At, exe) { Exe = exe, Args = args, Window = WindowRules.Window(o.Window) });
    }

    private void Clicked(MouseDown o)
    {
        var element = o.Element;
        if (_typing is not null)
        {
            if (FieldLeftBy(o) is null) return;
            _typing = null;
        }
        var combo = element.Ancestors.Select((a, i) => (a, i)).FirstOrDefault(x => x.a.ControlType == "ComboBox");
        if (element.ControlType == "ListItem" && combo.a is not null)
        {
            var select = Step(StepKind.Select, o.At, o.Window, combo.a, 1) with { Option = Literal(element.Name, combo.a) };
            AddFolding(select, takeClickTime: false);
            return;
        }
        if (element.IsChecked is { } wasChecked && element.ControlType != "RadioButton")
        {
            _steps.Add(Step(StepKind.Check, o.At, o.Window, element, o.Matches) with { Checked = !wasChecked });
            return;
        }
        // A click on a part of a ComboBox (its button) is a click on the ComboBox, which opens its list.
        var target = KeyRules.Field(element) == FieldKind.None && combo.a is not null && combo.i <= 1 ? combo.a : element;
        var click = Step(StepKind.Click, o.At, o.Window, target, ReferenceEquals(target, element) ? o.Matches : 1);
        // A second click on the same element within the double-click time makes the first a double-click. A check box
        // never gets here: two clicks on it toggle it twice.
        if (DoubleClickMs > 0 && _steps.Count > 0 && _steps[^1] is { Kind: StepKind.Click, Double: false } last && last.ElementId.Length > 0
            && last.ElementId == click.ElementId && (o.At - last.At).TotalMilliseconds <= DoubleClickMs)
        {
            _steps[^1] = last with { Double = true };
            return;
        }
        _steps.Add(click);
    }

    /// <summary>Space on a check box, a radio button or a button: what a click on it records (never a double-click).</summary>
    private void Activate(Activated o)
    {
        _typing = null;
        var element = o.Element;
        _steps.Add(element.IsChecked is { } wasChecked && element.ControlType != "RadioButton"
            ? Step(StepKind.Check, o.At, o.Window, element, 1) with { Checked = !wasChecked }
            : Step(StepKind.Click, o.At, o.Window, element, 1));
    }

    private void Pressed(KeyDown o)
    {
        if (o.Typing)
        {
            var kind = KeyRules.Field(o.Focused);
            if (kind != FieldKind.None && (_typing is null || !Same(_typing.Field, o.Focused))) _typing = new(o.Focused, o.Window, o.At, kind);
            return;
        }
        _typing = null;
        if (o.Chord.Length == 0) return;
        _steps.Add(Step(StepKind.Key, o.At, o.Window, o.Focused, 1) with { Chord = o.Chord });
    }

    private void Left(FieldLeft o)
    {
        if (_typing is not { } typing || !Same(typing.Field, o.Field)) return;
        _typing = null;
        var step = Step(typing.Kind == FieldKind.DropDown ? StepKind.Select : StepKind.Fill, typing.At, typing.Window, typing.Field, 1);
        if (typing.Kind == FieldKind.DropDown)
        {
            if (o.Selection is null) return;
            step = step with { Option = Literal(o.Selection, typing.Field) };
        }
        else if (SecretRules.IsSecret(typing.Field) || SecretRules.IsSecret(o.Field))
        {
            step = step with { Value = Variable(SecretRules.VariableName(typing.Field)), Secret = true };
        }
        else
        {
            if (o.Value is null) return;
            step = step with { Value = Literal(o.Value, typing.Field) };
            // A file name typed into a Save dialog: the run saves into its own export folder.
            var file = WindowRules.FileName(step.Value);
            if (typing.Window.ClassName == "#32770" && typing.Field.AutomationId == "1001" && step.Value == o.Value && IsFileName(file))
                step = step with { Value = $"{{{{$exportDir}}}}\\{file}", ExportFile = file };
        }
        AddFolding(step, takeClickTime: true);
    }

    /// <summary>
    /// Adds a fill or a select, folding into it the click on its element just before it (a fill then starts at that
    /// click, where the person entered the field) and the Tab or Shift+Tab keys that moved there.
    /// </summary>
    private void AddFolding(RecordedStep step, bool takeClickTime)
    {
        if (_steps.Count > 0 && _steps[^1] is { Kind: StepKind.Click } click && click.ElementId.Length > 0 && click.ElementId == step.ElementId)
        {
            _steps.RemoveAt(_steps.Count - 1);
            step = takeClickTime ? step with { At = click.At, Target = click.Target } : step with { FoldedAt = click.At };
        }
        while (_steps.Count > 0 && _steps[^1] is { Kind: StepKind.Key, Chord: "Tab" or "Shift+Tab" }) _steps.RemoveAt(_steps.Count - 1);
        _steps.Add(step);
    }

    public void Delete(int index) => _steps.RemoveAt(index);

    /// <summary>Makes a fill's value or a select's item the run variable <paramref name="name"/>. A secret fill stays secret.</summary>
    public void MarkVariable(int index, string name)
    {
        CheckName(name);
        var step = _steps[index];
        _steps[index] = step.Kind switch
        {
            StepKind.Fill => step with { Value = Variable(name), ExportFile = null },
            StepKind.Select => step with { Option = Variable(name) },
            _ => throw new InvalidOperationException("only a typed value or a selected item can be a variable"),
        };
    }

    /// <summary>Makes a fill secret: its value becomes the run variable <paramref name="name"/>, and the typed value is gone.</summary>
    public void MarkSecret(int index, string name)
    {
        CheckName(name);
        var step = _steps[index];
        if (step.Kind != StepKind.Fill) throw new InvalidOperationException("only a typed value can be secret");
        _steps[index] = step with { Value = Variable(name), ExportFile = null, Secret = true };
    }

    /// <summary>Adds a step that reads the element's text into the run output <paramref name="name"/>.</summary>
    public void AddRead(ElementFacts element, WindowFacts window, string name)
    {
        CheckName(name);
        if (_steps.Any(s => s.Kind == StepKind.Read && s.As == name)) throw new ArgumentException($"another read already gives {name}", nameof(name));
        var target = LocatorRules.ReadTarget(window, element, out var byText);
        _steps.Add(new RecordedStep(StepKind.Read, DateTimeOffset.Now, LocatorRules.ReadLabel(element))
        {
            Target = target, As = name, FoundByText = byText, Positional = LocatorRules.IsPositional(target), ElementId = element.RuntimeId,
        });
    }

    /// <summary>The recording file named <paramref name="name"/>: the steps, with a scope wherever the window changes.</summary>
    public RecordingFile ToFile(string name)
    {
        if (name.Length is 0 or > 200 || name.Contains('\r') || name.Contains('\n') || name.Contains("{{"))
            throw new ArgumentException("the name must be one line of 1 to 200 characters, without {{", nameof(name));
        var (exe, args) = _app ?? (_steps.Select(s => s.Target?.Window.Exe).FirstOrDefault(e => e is not null) is { } seen
            ? (seen, (IReadOnlyList<string>)[])
            : throw new InvalidOperationException("nothing was recorded"));
        var events = new List<RecordedStep>();
        RecordedWindow? current = null;
        foreach (var step in _steps)
        {
            if (step.Kind == StepKind.Launch) current = step.Window;
            else if (step.Target!.Window != current)
            {
                current = step.Target.Window;
                events.Add(new RecordedStep(StepKind.Scope, step.StartedAt, Texts.Label(current.Title ?? current.ClassName ?? current.Exe ?? "")) { Window = current });
            }
            events.Add(step);
        }
        if (events.Count > RecordingFile.MaxEvents)
            throw new InvalidOperationException($"a recording holds at most {RecordingFile.MaxEvents} events; this one has {events.Count}: delete steps or record the work in shorter parts");
        var secrets = _steps.Where(s => s.Secret).Select(s => s.Value![6..^2]).Distinct().ToArray();
        return new RecordingFile(name, exe, args, events, secrets);
    }

    /// <summary>The change that allows the recorded application, by its path and SHA-256, for <c>RpaPolicy.exe apply</c>.
    /// It declares no write controls and no gated keys: the approver declares writes.</summary>
    public PolicyChange ToPolicyChange(string exePath, string sha256)
    {
        if (sha256.Length != 64 || !sha256.All(char.IsAsciiHexDigit)) throw new ArgumentException("the hash must be a SHA-256 in 64 hex characters", nameof(sha256));
        var exe = WindowRules.FileName(exePath);
        var args = _app?.Args ?? [];
        if (_app is { } app && !string.Equals(app.Exe, exe, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"the recording's application is {app.Exe}, not {exe}", nameof(exePath));
        return new PolicyChange(exe, exePath, sha256, args);
    }

    private static RecordedStep Step(StepKind kind, DateTimeOffset at, WindowFacts window, ElementFacts element, int matches)
    {
        var target = LocatorRules.Target(window, element, matches);
        return new RecordedStep(kind, at, LocatorRules.Label(element)) { Target = target, Positional = LocatorRules.IsPositional(target), ElementId = element.RuntimeId };
    }

    private static bool Same(ElementFacts a, ElementFacts b) => a.RuntimeId.Length > 0 && a.RuntimeId == b.RuntimeId;

    private static string Variable(string name) => $"{{{{var.{name}}}}}";

    /// <summary>A typed value or a selected item as the steps keep it. A step has no way to write <c>{{</c> as text (the
    /// run reads it as a template), so such a value becomes the field's variable, which the person fills in.</summary>
    private static string Literal(string value, ElementFacts field) => value.Contains("{{") ? Variable(SecretRules.VariableName(field)) : value;

    private static void CheckName(string name)
    {
        if (!SecretRules.IsVariableName(name)) throw new ArgumentException("a variable's name starts with a letter or _ and holds only letters, digits and _", nameof(name));
    }

    /// <summary>A file name without a folder, as the importer takes it (FILE_NAME in recording.ts).</summary>
    private static bool IsFileName(string name) =>
        name.Length is > 0 and <= 255 && name is not "." and not ".." && !name.Any(c => c is '\\' or '/' or ':' or '*' or '?' or '"' or '<' or '>' or '|' || char.IsControl(c));
}
