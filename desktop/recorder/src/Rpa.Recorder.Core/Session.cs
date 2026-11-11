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
    /// <summary>
    /// The start values, each kept with the step it came from (that step's record, by reference): the name it was made a
    /// variable under and the value it held then. A step made secret, deleted, or changed in any other way is no longer
    /// in <see cref="_steps"/> as that record, so what it contributed counts no more (<see cref="ToFile"/>).
    /// </summary>
    private readonly List<(RecordedStep Step, string Name, string Value)> _startValues = [];
    /// <summary>SHA-256 of every value a step held when it was made secret in this session (never the value itself): no
    /// start value equal to one is written.</summary>
    private readonly HashSet<string> _madeSecret = [];
    /// <summary>The longest start value the importer takes (MAX_START_VALUE in recording.ts).</summary>
    public const int MaxStartValueLength = 500;
    private (string Exe, IReadOnlyList<string> Args)? _app;
    /// <summary>The field the person is typing into, until they leave it. Its value is never kept here.</summary>
    private Typing? _typing;

    private sealed record Typing(ElementFacts Field, WindowFacts Window, DateTimeOffset At, FieldKind Kind);

    /// <summary>The runtime ids of the Save dialogs' file-name boxes typed into since their dialog was last accepted:
    /// the typed name already gave its step.</summary>
    private readonly HashSet<string> _typedNameBoxes = [];
    private enum SaveNotice { None, Due, Given }
    private SaveNotice _saveNotice;

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
            case FileDialogAccepted accepted: Accepted(accepted); break;
            default: throw new ArgumentException($"unknown observation {o.GetType().Name}", nameof(o));
        }
    }

    /// <summary>The most arguments, and the longest, a desktop step set takes (the engine's step parser).</summary>
    public const int MaxArgs = 50, MaxArgLength = 1000;

    /// <summary>
    /// The recording is of a program whose window was already open (Use an open app…): the recording's app is that
    /// program (<paramref name="exePath"/>, its file), with no arguments, and no launch step (the importer adds one).
    /// </summary>
    public void Attach(string exePath)
    {
        if (_app is not null) throw new InvalidOperationException("a recording records one application");
        var exe = WindowRules.FileName(exePath);
        if (!WindowRules.IsExeName(exe)) throw new ArgumentException("the application must be a program (.exe)", nameof(exePath));
        _app = (exe, []);
    }

    private void Started(AppStarted o)
    {
        if (_app is not null) throw new InvalidOperationException("a recording records one application");
        var exe = WindowRules.FileName(o.ExePath);
        if (!WindowRules.IsExeName(exe)) throw new ArgumentException("the application must be a program (.exe)", nameof(o));
        if (o.Args.Any(a => a.Contains("{{"))) throw new ArgumentException("the application's arguments may not hold {{", nameof(o));
        if (o.Args.Count > MaxArgs || o.Args.Any(a => a.Length > MaxArgLength))
            throw new ArgumentException($"A recording takes at most {MaxArgs} arguments of at most {MaxArgLength} characters each, as Import Steps does.", nameof(o));
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
            // An empty item (a blank first entry) cannot be chosen by a step: no select is recorded.
            if (element.Name.Length == 0) return;
            var select = Step(StepKind.Select, o.At, o.Window, combo.a, 1) with { Option = Literal(element.Name, combo.a) };
            AddFolding(select, takeClickTime: false);
            return;
        }
        if (element.IsChecked is { } wasChecked && element.ControlType == "CheckBox")
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
        _steps.Add(element.IsChecked is { } wasChecked && element.ControlType == "CheckBox"
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
        if (FileDialogs.IsFileNameBox(typing.Window, typing.Field)) _typedNameBoxes.Add(typing.Field.RuntimeId);
        var step = Step(typing.Kind == FieldKind.DropDown ? StepKind.Select : StepKind.Fill, typing.At, typing.Window, typing.Field, 1);
        if (typing.Kind == FieldKind.DropDown)
        {
            if (string.IsNullOrEmpty(o.Selection)) return;
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
            if (FileDialogs.IsFileNameBox(typing.Window, typing.Field) && step.Value == o.Value && FileDialogs.IsFileName(file))
                step = step with { Value = ExportValue(file), ExportFile = file };
        }
        AddFolding(step, takeClickTime: true);
    }

    /// <summary>Whether the Windows layer reads <paramref name="box"/> when its dialog is accepted: only a Save dialog's
    /// file-name box (<see cref="FileDialogs.IsFileNameBox"/>) that was not typed into since that dialog opened (a typed
    /// name gave its step when the box was left).</summary>
    public bool ReadsNameBox(WindowFacts dialog, ElementFacts box) =>
        FileDialogs.IsFileNameBox(dialog, box) && !SecretRules.IsSecret(box) && !_typedNameBoxes.Contains(box.RuntimeId);

    /// <summary>
    /// A Save dialog accepted with the name its box holds: the same export step a typed name gives, so the run saves into
    /// its own export folder. A name typed into the box gave its step already. A name that is not a plain file name (a
    /// path, nothing, a name a step cannot type) or that was not read makes no step: the file stays where the app puts
    /// it, and the bar says so once (<see cref="TakeSaveNotice"/>).
    /// </summary>
    private void Accepted(FileDialogAccepted o)
    {
        if (!FileDialogs.IsFileNameBox(o.Window, o.Field)) return;
        if (_typedNameBoxes.Remove(o.Field.RuntimeId)) return;
        var name = SecretRules.IsSecret(o.Field) ? null : o.Value;
        if (name is null || !FileDialogs.IsFileName(name) || name.Contains("{{"))
        {
            if (_saveNotice == SaveNotice.None) _saveNotice = SaveNotice.Due;
            return;
        }
        _steps.Add(Step(StepKind.Fill, o.At, o.Window, o.Field, 1) with { Value = ExportValue(name), ExportFile = name });
    }

    /// <summary>True once in a recording, after a Save dialog was accepted without an export step: the bar then shows
    /// <see cref="Notices.SaveKeepsFolder"/>.</summary>
    public bool TakeSaveNotice()
    {
        if (_saveNotice != SaveNotice.Due) return false;
        _saveNotice = SaveNotice.Given;
        return true;
    }

    private static string ExportValue(string file) => $"{{{{$exportDir}}}}\\{file}";

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

    /// <summary>Deletes a step, and the start value it gave a variable.</summary>
    public void Delete(int index)
    {
        var step = _steps[index];
        _steps.RemoveAt(index);
        _startValues.RemoveAll(c => ReferenceEquals(c.Step, step));
    }

    /// <summary>Makes a fill's value or a select's item the run variable <paramref name="name"/>. A secret fill stays secret.
    /// The value it held becomes the variable's start value (see <see cref="ToFile"/>), unless the fill is secret.</summary>
    public void MarkVariable(int index, string name)
    {
        CheckName(name);
        var step = _steps[index];
        var marked = step.Kind switch
        {
            StepKind.Fill => step with { Value = Variable(name), ExportFile = null },
            StepKind.Select => step with { Option = Variable(name) },
            _ => throw new InvalidOperationException("only a typed value or a selected item can be a variable"),
        };
        // The value this step gives its variable: the one it holds now, or, when it is already a variable (a rename), the
        // value it contributed then. Whatever it contributed before goes with the old record.
        var recorded = step.Kind == StepKind.Fill ? step.Value : step.Option;
        var before = _startValues.FindIndex(c => ReferenceEquals(c.Step, step));
        var value = before >= 0 ? _startValues[before].Value
            : recorded is not null && !step.Secret && step.ExportFile is null && !recorded.Contains("{{") ? recorded : null;
        if (before >= 0) _startValues.RemoveAt(before);
        _steps[index] = marked;
        if (value is not null && !step.Secret) _startValues.Add((marked, name, value));
    }

    /// <summary>The start value <paramref name="step"/> gives its variable, as the file gets it (<see cref="ToFile"/>), or
    /// null when it gives none.</summary>
    public string? StartValue(RecordedStep step)
    {
        var (from, _, value) = _startValues.FirstOrDefault(c => ReferenceEquals(c.Step, step));
        return from is not null && !step.Secret && Writable(value) ? value : null;
    }

    /// <summary>A start value the file may hold: never one made secret in this session, and only one the importer takes
    /// (one line of at most 500 characters).</summary>
    private bool Writable(string value) =>
        value.Length is > 0 and <= MaxStartValueLength && !value.Contains('\r') && !value.Contains('\n') && !_madeSecret.Contains(Hash(value));

    /// <summary>Makes a fill secret: its value becomes the run variable <paramref name="name"/>, and the typed value is gone.</summary>
    public void MarkSecret(int index, string name)
    {
        CheckName(name);
        var step = _steps[index];
        if (step.Kind != StepKind.Fill) throw new InvalidOperationException("only a typed value can be secret");
        // Neither the value the step holds nor the start value it gave a variable may reach the file from now on.
        if (step.Value is { } typed && !typed.Contains("{{")) _madeSecret.Add(Hash(typed));
        foreach (var c in _startValues.Where(c => ReferenceEquals(c.Step, step))) _madeSecret.Add(Hash(c.Value));
        _startValues.RemoveAll(c => ReferenceEquals(c.Step, step));
        _steps[index] = step with { Value = Variable(name), ExportFile = null, Secret = true };
    }

    private static string Hash(string value) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)));

    /// <summary>Adds a step that reads the element's text into the run output <paramref name="name"/>.</summary>
    public void AddRead(ElementFacts element, WindowFacts window, string name)
    {
        CheckName(name);
        if (SecretRules.IsSecret(element)) throw new ArgumentException(Notices.PasswordNotRead, nameof(element));
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
        // A start value for a name only while the step it came from is still in the steps as a non-secret variable of that
        // name; the first such step's value when two share a name. Never for a secret variable's name, never a value that
        // was made secret in this session, and only a value the importer takes (one line of at most 500 characters).
        var variables = new Dictionary<string, string>();
        foreach (var (step, varName, value) in _startValues)
        {
            var kept = _steps.FirstOrDefault(s => ReferenceEquals(s, step));
            var typed = kept?.Kind == StepKind.Fill ? kept.Value : kept?.Option;
            if (kept is null || kept.Secret || typed != Variable(varName) || secrets.Contains(varName) || !Writable(value)) continue;
            variables.TryAdd(varName, value);
        }
        return new RecordingFile(name, exe, args, events, secrets) { Variables = variables };
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
        if (!SecretRules.IsVariableName(name))
            throw new ArgumentException("A variable's name starts with a letter or _, holds only letters, digits and _, and has at most 64 characters.", nameof(name));
    }
}
