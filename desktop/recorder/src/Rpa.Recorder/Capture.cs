using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FlaUI.Core.AutomationElements;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>Something the recorder tells the person. <c>Text</c> may name a step's element; it never holds typed text.</summary>
internal sealed record Notice(NoticeKind Kind, DateTimeOffset At, string Text);

/// <summary>
/// Turns what the hooks report and what UI Automation answers into the session's observations, in order:
/// <list type="bullet">
/// <item>a mouse-down and a key that is not typing are described while the hook holds the input, for at most
/// <see cref="BudgetMs"/>; an answer that came later is recorded as it is and marked for the person to check;</item>
/// <item>typing keys do not wait, and only their time and focused element are used (never the key);</item>
/// <item>the field being typed into is read when it is left, before the input that leaves it goes on, and a secret
/// field (<see cref="SecretRules.IsSecret"/>) is never read;</item>
/// <item>a Save dialog's file-name box is read when the dialog is accepted, before the input goes on, unless it was
/// typed into; nothing else of a dialog is read;</item>
/// <item>the recorder's own windows are never recorded.</item>
/// </list>
/// The rules themselves are in Rpa.Recorder.Core; this class only asks Windows and UI Automation.
/// </summary>
internal sealed class Capture : IDisposable
{
    public const int BudgetMs = 200;
    private const int F9 = 0x78;

    // The system's double-click time, read once: two clicks on one element within it are one double-click.
    private readonly Session _session = new() { DoubleClickMs = (int)Native.GetDoubleClickTime() };
    private AppScope? _scope;
    // The recorded process, held open while the recorder runs (so its id is not given to another program), and the wait
    // that tells the scope when it exits.
    private ProcessWait? _appHandle;
    private RegisteredWaitHandle? _appWait;

    // The recorded application's top-level window that last had the person's input: the bar gives it the activation back
    // after its own actions, so the person's next click acts in the app instead of only activating its window.
    private volatile IntPtr _lastAppWindow;

    private sealed class ProcessWait : WaitHandle
    {
        public ProcessWait(Microsoft.Win32.SafeHandles.SafeWaitHandle handle) => SafeWaitHandle = handle;
    }
    private readonly object _gate = new();
    private readonly HashSet<DateTimeOffset> _late = [];
    // What a read's element showed when F9 was pressed, by the read step's time: the bar says it; the file does not.
    private readonly Dictionary<DateTimeOffset, string> _seen = [];
    private readonly UiaWorker _worker = new();
    private readonly Hooks _hooks;
    private readonly HookWatch _watch = new();
    private readonly Dictionary<NoticeKind, long> _lastNotice = [];
    private readonly Dictionary<uint, bool> _elevated = [];
    private readonly uint _ownProcess = (uint)Environment.ProcessId;
    private readonly bool _selfElevated;
    private readonly bool _readKey;
    private System.Threading.Timer? _watchTimer;
    private volatile bool _recording;
    // The field being typed into, as UI Automation gave it: only the worker thread uses these.
    private AutomationElement? _fieldElement;
    private string _fieldId = "";
    private WindowFacts? _fieldWindow;

    /// <param name="readKey">Whether F9 reads the value under the pointer (the bar); headless mode has no F9.</param>
    public Capture(bool readKey)
    {
        _readKey = readKey;
        _selfElevated = Native.IsElevated(_ownProcess);
        _hooks = new Hooks { MouseDown = OnMouseDown, MouseUp = OnMouseUp, KeyDown = OnKeyDown, Seen = OnSeen };
    }

    /// <summary>The steps changed.</summary>
    public event Action? Changed;
    public event Action<Notice>? Noticed;
    /// <summary>F9 was pressed over this element: the bar asks for the output's name and calls <see cref="AddRead"/>.</summary>
    public event Action<ElementFacts, WindowFacts>? ReadRequested;

    /// <summary>The program the recording is of: the one the recorder started, or the one whose window it records.</summary>
    public string? ProgramPath { get; private set; }
    public int? AppProcessId { get; private set; }
    public bool Recording => _recording;

    /// <summary>Starts the program and records once it shows a window. False (and a notice) when it did not start;
    /// ArgumentException, before anything starts, for a program or arguments a recording cannot hold.</summary>
    public bool Launch(string path, IReadOnlyList<string> args)
    {
        // The session's own check of the program and its arguments, on a session that is thrown away.
        new Session().Add(new AppStarted(DateTimeOffset.Now, path, args, new WindowFacts("", "", "")));
        var at = DateTimeOffset.Now;
        ProcessWait process;
        int processId;
        try
        {
            // Started without the recorder's handles: a program that held the recorder's standard output open would
            // keep whoever reads it waiting after the recorder ends.
            var (handle, id) = Native.Start(path, args, Path.GetDirectoryName(path));
            (process, processId) = (new ProcessWait(handle), id);
        }
        catch (Win32Exception e) when (e.NativeErrorCode == 740) // ERROR_ELEVATION_REQUIRED
        {
            Notify(NoticeKind.Elevated, Notices.Elevated);
            return false;
        }
        catch (Win32Exception e)
        {
            Notify(NoticeKind.NotStarted, Notices.DidNotStart(e.Message));
            return false;
        }
        var window = IntPtr.Zero;
        for (var waited = 0; waited < 30000 && window == IntPtr.Zero && !process.WaitOne(0); waited += 100)
        {
            window = Native.TopLevelWindows().FirstOrDefault(h => Native.ProcessOf(h) == processId);
            if (window == IntPtr.Zero) Thread.Sleep(100);
        }
        if (window == IntPtr.Zero)
        {
            process.Dispose();
            Notify(NoticeKind.NotStarted, Notices.NotStarted);
            return false;
        }
        lock (_gate) _session.Add(new AppStarted(at, path, args, UiaWorker.Window(window)));
        ProgramPath = path;
        AppProcessId = processId;
        _lastAppWindow = window;
        _scope = ScopeOf(processId, path);
        Watch(process);
        Begin();
        return true;
    }

    /// <summary>Records in a window that is already open. False (and a notice) for a program that runs as administrator
    /// when the recorder does not.</summary>
    public bool Attach(IntPtr window)
    {
        var process = Native.ProcessOf(window);
        if (process == _ownProcess) return false;
        if (IsElevated(process))
        {
            Notify(NoticeKind.Elevated, Notices.Elevated);
            return false;
        }
        var path = Native.ImagePath(process);
        try
        {
            // The recording's app is the attached program, as the policy change's is.
            lock (_gate) _session.Attach(path ?? throw new ArgumentException(Notices.ProgramUnknown));
        }
        catch (ArgumentException)
        {
            Notify(NoticeKind.NotStarted, Notices.ProgramUnknown);
            return false;
        }
        ProgramPath = path;
        AppProcessId = (int)process;
        _lastAppWindow = window;
        _scope = new AppScope((int)process, path);
        var handle = Native.OpenToWatch(process);
        if (handle is null) _scope.AppExited();
        else Watch(new ProcessWait(handle));
        Begin();
        return true;
    }

    /// <summary>The recorded application: its process, and its program file as Windows names it.</summary>
    private static AppScope ScopeOf(int processId, string path) => new(processId, Native.ImagePath((uint)processId) ?? path);

    /// <summary>
    /// Holds the recorded process open (its handle) and tells the scope when it exits. A process that cannot be held
    /// counts as exited at once (Attach): its id alone is then never in scope (another process of its program file
    /// still is).
    /// </summary>
    private void Watch(ProcessWait process)
    {
        _appHandle = process;
        var scope = _scope;
        _appWait = ThreadPool.RegisterWaitForSingleObject(_appHandle, (_, _) => scope?.AppExited(), null, Timeout.Infinite, executeOnlyOnce: true);
    }

    /// <summary>Whether a process's input belongs to the recording (<see cref="AppScope"/>).</summary>
    private bool InScope(uint processId) => _scope?.Includes((int)processId, id => Native.ImagePath((uint)id)) == true;

    /// <summary>Input in another program: nothing of it is recorded, and the field being typed into in the recorded
    /// application is left (it was).</summary>
    private void OtherProgram()
    {
        _worker.Post(LeaveFieldNow);
        Notify(NoticeKind.OtherProgram, Notices.OtherPrograms);
    }

    private void Begin()
    {
        lock (_watch) _watch.Reinstalled(Environment.TickCount64);
        _hooks.Start();
        _watchTimer ??= new System.Threading.Timer(_ => CheckHooks(), null, 500, 500);
        _recording = true;
        Changed?.Invoke();
    }

    /// <summary>Pauses or resumes. A field being typed into is read first: what was typed so far is recorded.</summary>
    public void Pause(bool paused)
    {
        if (paused) { _recording = false; _worker.Post(LeaveFieldNow).Wait(); }
        else _recording = true;
        Changed?.Invoke();
    }

    /// <summary>Stops recording: the field being typed into is read, and the hooks are removed.</summary>
    public void Stop()
    {
        _recording = false;
        _worker.Post(LeaveFieldNow).Wait();
        _watchTimer?.Dispose();
        _watchTimer = null;
        _hooks.Dispose();
        Changed?.Invoke();
    }

    /// <summary>Gives the activation back to the recorded application's window that last had the person's input (the bar
    /// is the foreground program when it calls this, so Windows allows it).</summary>
    public void GiveFocusBack()
    {
        var window = _lastAppWindow;
        if (window != IntPtr.Zero && Native.IsWindow(window) && Native.IsWindowVisible(window)) Native.SetForegroundWindow(window);
    }

    /// <summary>Runs something on the session (the bar's delete and mark actions), then tells the bar.</summary>
    public T Use<T>(Func<Session, T> use)
    {
        T result;
        lock (_gate) result = use(_session);
        Changed?.Invoke();
        return result;
    }

    /// <summary>The steps, each with whether its answer came too late and it should be checked.</summary>
    public IReadOnlyList<(RecordedStep Step, bool Late)> Steps()
    {
        lock (_gate) return _session.Steps.Select(s => (s, _late.Contains(s.At))).ToArray();
    }

    /// <summary>The start value a step gives its variable (<see cref="Session.StartValue"/>), or null.</summary>
    public string? StartValue(RecordedStep step)
    {
        lock (_gate) return _session.StartValue(step);
    }

    public void AddRead(ElementFacts element, WindowFacts window, string name) =>
        Use(s => { s.AddRead(element, window, name); _seen[s.Steps[^1].At] = element.Name; return 0; });

    /// <summary>What a read step's element showed when it was added, or null.</summary>
    public string? Seen(RecordedStep step)
    {
        lock (_gate) return step.Kind == StepKind.Read && _seen.TryGetValue(step.At, out var text) ? text : null;
    }

    /// <summary>
    /// Writes the recording file and the policy change file into the folder and returns their paths. Without
    /// <paramref name="overwrite"/> an existing file is never replaced (IOException).
    /// </summary>
    public (string Recording, string PolicyChange) Save(string folder, string name, bool overwrite)
    {
        var program = ProgramPath ?? throw new InvalidOperationException("the program's file is not known, so no policy change can be made for it");
        RecordingFile file;
        string change;
        lock (_gate)
        {
            file = _session.ToFile(name);
            change = _session.ToPolicyChange(program, Sha256(program)).ToJson();
        }
        var paths = (Path.Combine(folder, SaveNames.Recording(name)), Path.Combine(folder, SaveNames.PolicyChange(name)));
        Write(paths.Item1, file.ToJson(), overwrite);
        Write(paths.Item2, change, overwrite);
        // Saved all the same: the person can delete steps and save again.
        if (file.EstimatedSteps > RecordingFile.MaxSteps) Notify(NoticeKind.TooManySteps, Notices.TooManySteps(file.EstimatedSteps), always: true);
        return paths;
    }

    private static void Write(string path, string text, bool overwrite)
    {
        using var file = new FileStream(path, overwrite ? FileMode.Create : FileMode.CreateNew, FileAccess.Write, FileShare.None);
        file.Write(new UTF8Encoding(false).GetBytes(text));
    }

    private static string Sha256(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(file));
    }

    public void Dispose()
    {
        _recording = false;
        _watchTimer?.Dispose();
        _hooks.Dispose();
        _worker.Dispose();
        _appWait?.Unregister(null);
        _appHandle?.Dispose();
    }

    // ---- The hooks' thread: short, and never more than the budget. ----

    private void OnSeen()
    {
        lock (_watch) _watch.Seen(Environment.TickCount64);
    }

    private void OnMouseUp()
    {
        lock (_watch) _watch.MouseUp(Environment.TickCount64);
    }

    private void OnMouseDown(int x, int y)
    {
        bool missed;
        lock (_watch) missed = _watch.MouseDown(Environment.TickCount64);
        if (missed) HooksLost();
        if (!_recording) return;
        var under = Native.ProcessOf(Native.GetAncestor(Native.WindowFromPoint(new Native.POINT { X = x, Y = y }), Native.GA_ROOT));
        if (under == _ownProcess) return;
        if (!InScope(under)) { OtherProgram(); return; }
        var job = Stopwatch.StartNew();
        var at = DateTimeOffset.Now;
        // Held only until the element is described and the field being left is read; the rest comes after.
        var described = new ManualResetEventSlim(false);
        _worker.Post(() => Mouse(at, job, described, x, y));
        described.Wait(BudgetMs);
    }

    private bool OnKeyDown(int vk, bool ctrl, bool alt, bool shift, bool win)
    {
        if (!_recording) return false;
        // Modifiers alone, and the keys that belong to Windows (Win chords, Alt+Tab, Ctrl+Esc...), are never recorded.
        var kind = KeyRules.Kind(vk, ctrl, alt, win);
        if (kind is KeyKind.Modifier or KeyKind.Shell) return false;
        var foreground = Native.ProcessOf(Native.GetForegroundWindow());
        if (foreground == _ownProcess) return false;
        // Another program has the keyboard: the key goes on untouched (F9 too), and nothing of it is passed on.
        if (!InScope(foreground)) { OtherProgram(); return false; }
        var at = DateTimeOffset.Now;
        if (_readKey && vk == F9 && !ctrl && !alt && !shift)
        {
            _worker.Post(ReadAtPointer);
            return true;
        }
        bool typing;
        lock (_gate) typing = _session.FieldBeingTyped is not null;
        if (KeyRules.MayActivate(vk, ctrl, alt, typing))
        {
            // Space: what a click records on a check box, radio button or button, read before the key goes on;
            // otherwise it is a typing key like any other.
            var space = Stopwatch.StartNew();
            _worker.Post(() => Space(at, space)).Wait(BudgetMs);
            return false;
        }
        if (kind == KeyKind.Printable)
        {
            // Typing: no wait, and the key itself goes no further than this line (only whether Ctrl and Alt were held).
            _worker.Post(() => Key(at, null, KeyKind.Printable, null, ctrl, alt));
            return false;
        }
        var job = Stopwatch.StartNew();
        var chord = KeyRules.Chord(ctrl, alt, shift, KeyRules.KeyName(vk)!);
        _worker.Post(() => Key(at, job, kind, chord)).Wait(BudgetMs);
        return false;
    }

    // ---- The worker's thread. ----

    /// <summary>
    /// A mouse-down. What must come before the click goes on is done first: the element's description (with its toggle
    /// state) and reading the field the click leaves; then <paramref name="described"/> lets the input go on. A step is
    /// late only when that part took longer than the budget. Its locator's matches are counted after, in the window as
    /// it is then; when the element is gone by then, it counts as 1 (recorded with what there is).
    /// </summary>
    private void Mouse(DateTimeOffset at, Stopwatch job, ManualResetEventSlim described, int x, int y)
    {
        try
        {
            var top = Native.GetAncestor(Native.WindowFromPoint(new Native.POINT { X = x, Y = y }), Native.GA_ROOT);
            var process = Native.ProcessOf(top);
            if (process == _ownProcess) return;
            if (IsElevated(process)) { Notify(NoticeKind.Elevated, Notices.Elevated); return; }
            Described? d;
            try { d = _worker.At(x, y); }
            catch (Exception e) when (e is UnauthorizedAccessException || (e is COMException c && c.HResult == unchecked((int)0x80070005)))
            {
                Notify(NoticeKind.Elevated, Notices.Elevated);
                return;
            }
            if (d is null || d.ProcessId == _ownProcess || !InScope(d.ProcessId)) return;
            _lastAppWindow = top;
            var window = UiaWorker.WindowOf(d, top);
            var down = new MouseDown(at, window, d.Facts, 1);
            LeaveField(down);
            AcceptFileDialog(down, top, null);
            var late = job.ElapsedMilliseconds > BudgetMs;
            described.Set();
            var matches = _worker.CountMatches(window, LocatorRules.Condition(d.Facts), d.ProcessId);
            Add(down with { Matches = matches == 0 ? 1 : matches }, late, d.Facts);
        }
        finally { described.Set(); }
    }

    /// <summary>A key on the focused element: typing (<paramref name="chord"/> null) or a key event. A Ctrl+Alt key
    /// that types, dropped because no field has the focus, is said on the bar.</summary>
    private void Key(DateTimeOffset at, Stopwatch? job, KeyKind kind, string? chord, bool ctrl = false, bool alt = false)
    {
        var d = _worker.Focused();
        if (d is null || d.ProcessId == _ownProcess || !InScope(d.ProcessId)) return;
        var root = Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT);
        _lastAppWindow = root;
        var window = UiaWorker.WindowOf(d, Native.GetForegroundWindow());
        var fieldKind = KeyRules.Field(d.Facts);
        if (Notices.ShortcutDropped(ctrl, alt, kind, fieldKind)) Notify(NoticeKind.CtrlAltDropped, Notices.CtrlAltDropped);
        var typing = kind == KeyKind.Printable || KeyRules.IsTyping(kind, fieldKind);
        var key = new KeyDown(at, window, d.Facts, typing ? "" : chord ?? "", typing);
        LeaveField(key);
        AcceptFileDialog(key, root, d);
        Add(key, job is not null && !typing && job.ElapsedMilliseconds > BudgetMs, d.Facts);
        lock (_gate)
        {
            if (typing && _session.FieldBeingTyped is { } field && field.RuntimeId == d.Facts.RuntimeId && _fieldId != field.RuntimeId)
                (_fieldElement, _fieldId, _fieldWindow) = (d.Element, field.RuntimeId, window);
        }
    }

    private void Space(DateTimeOffset at, Stopwatch job)
    {
        var d = _worker.Focused();
        if (d is null || d.ProcessId == _ownProcess || !InScope(d.ProcessId)) return;
        if (!KeyRules.Activates(d.Facts)) { Key(at, null, KeyKind.Printable, null); return; }
        var activated = new Activated(at, UiaWorker.WindowOf(d, Native.GetForegroundWindow()), d.Facts);
        LeaveField(activated);
        AcceptFileDialog(activated, Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT), null);
        Add(activated, job.ElapsedMilliseconds > BudgetMs, d.Facts);
    }

    private void ReadAtPointer()
    {
        if (!Native.GetCursorPos(out var point)) return;
        var top = Native.GetAncestor(Native.WindowFromPoint(point), Native.GA_ROOT);
        if (Native.ProcessOf(top) == _ownProcess) return;
        var d = _worker.At(point.X, point.Y);
        if (d is null || d.ProcessId == _ownProcess || !InScope(d.ProcessId)) return;
        // A password field: the runner never reads one, so a read of it would fail on every run.
        if (SecretRules.IsSecret(d.Facts, UiaWorker.ReadPasswordFlag(d.Element))) { Notify(NoticeKind.NotRead, Notices.PasswordNotRead, always: true); return; }
        ReadRequested?.Invoke(d.Facts, UiaWorker.WindowOf(d, top));
    }

    /// <summary>When <paramref name="next"/> leaves the field being typed into, reads it (unless it is secret) and adds
    /// its FieldLeft, before <paramref name="next"/> is added and before the input goes on.</summary>
    private void LeaveField(Observation next)
    {
        ElementFacts? field;
        lock (_gate) field = _session.FieldLeftBy(next);
        if (field is not null) Leave(field, next.At);
    }

    /// <summary>
    /// When <paramref name="accepting"/> accepts a Save dialog (<see cref="FileDialogs.AcceptedDialog"/>), reads that
    /// dialog's file-name box before the input goes on, and nothing else of it: the session makes the name it holds the
    /// export step a typed name makes. The box is not read when it was typed into (its step is there) or when it may be
    /// a password box.
    /// </summary>
    private void AcceptFileDialog(Observation accepting, IntPtr dialog, Described? focused)
    {
        if (FileDialogs.AcceptedDialog(accepting) is not { } window) return;
        var box = focused is not null && FileDialogs.IsFileNameBox(window, focused.Facts) ? focused : _worker.FileNameBox(dialog, window);
        if (box is null) return;
        bool reads;
        lock (_gate) reads = _session.ReadsNameBox(window, box.Facts);
        var value = reads && !SecretRules.IsSecret(box.Facts, UiaWorker.ReadPasswordFlag(box.Element)) ? UiaWorker.ReadValue(box.Element) : null;
        bool notice;
        lock (_gate)
        {
            _session.Add(new FileDialogAccepted(accepting.At, window, box.Facts, value));
            notice = _session.TakeSaveNotice();
        }
        if (notice) Notify(NoticeKind.SaveKeepsFolder, Notices.SaveKeepsFolder, always: true);
    }

    private void LeaveFieldNow()
    {
        ElementFacts? field;
        lock (_gate) field = _session.FieldBeingTyped;
        if (field is not null) Leave(field, DateTimeOffset.Now);
    }

    private void Leave(ElementFacts field, DateTimeOffset at)
    {
        string? value = null, selection = null;
        // The secret check comes first, from the field's facts and its password flag read again now: a secret field's
        // value is never asked for, and a flag that cannot be read counts as set.
        if (!SecretRules.IsSecret(field) && _fieldElement is { } live && _fieldId == field.RuntimeId)
        {
            if (SecretRules.IsSecret(field, UiaWorker.ReadPasswordFlag(live))) field = field with { IsPassword = true };
            else if (KeyRules.Field(field) == FieldKind.DropDown) selection = UiaWorker.ReadSelection(live);
            else value = UiaWorker.ReadValue(live);
        }
        var window = _fieldWindow ?? new WindowFacts("", "", "");
        (_fieldElement, _fieldId, _fieldWindow) = (null, "", null);
        lock (_gate) _session.Add(new FieldLeft(at, window, field, value, selection));
        // Typed into, but nothing could be read: say so, rather than leave the recording silently short of a step.
        if (!field.IsPassword && !SecretRules.IsSecret(field) && (KeyRules.Field(field) == FieldKind.DropDown ? selection is null : value is null))
            Notify(NoticeKind.NotRead, Notices.NotRead(LocatorRules.Label(field)), always: true);
        Changed?.Invoke();
    }

    private void Add(Observation observation, bool late, ElementFacts element)
    {
        bool overwrite;
        lock (_gate)
        {
            _session.Add(observation);
            if (late) _late.Add(observation.At);
            overwrite = _session.TakeOverwriteNotice();
        }
        if (late) Notify(NoticeKind.Late, Notices.Late(LocatorRules.Label(element)), always: true);
        if (overwrite) Notify(NoticeKind.OverwriteLeftOut, Notices.OverwriteLeftOut, always: true);
        // Typing changes no step until the field is left.
        if (observation is not KeyDown { Typing: true }) Changed?.Invoke();
    }

    // ---- Hook watch (a timer thread). ----

    private void CheckHooks()
    {
        if (!_recording) return;
        bool lost;
        lock (_watch) lost = _watch.Lost(Native.LastInputMs());
        if (lost) HooksLost();
    }

    private void HooksLost()
    {
        _hooks.Reinstall();
        lock (_watch) _watch.Reinstalled(Environment.TickCount64);
        Notify(NoticeKind.HookLost, Notices.HookLost);
    }

    private bool IsElevated(uint process)
    {
        if (_selfElevated) return false;
        lock (_elevated)
        {
            if (!_elevated.TryGetValue(process, out var elevated)) _elevated[process] = elevated = Native.IsElevated(process);
            return elevated;
        }
    }

    /// <summary>Tells the person, at most once in 10 s for the same kind of notice (unless <paramref name="always"/>).</summary>
    private void Notify(NoticeKind kind, string text, bool always = false)
    {
        var now = Environment.TickCount64;
        lock (_lastNotice)
        {
            if (!always && _lastNotice.TryGetValue(kind, out var last) && now - last < 10000) return;
            _lastNotice[kind] = now;
        }
        Noticed?.Invoke(new Notice(kind, DateTimeOffset.Now, text));
    }
}
