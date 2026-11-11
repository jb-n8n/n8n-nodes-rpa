using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FlaUI.Core.AutomationElements;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

internal enum NoticeKind { Late, HookLost, Elevated, NotStarted }

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
/// <item>the recorder's own windows are never recorded.</item>
/// </list>
/// The rules themselves are in Rpa.Recorder.Core; this class only asks Windows and UI Automation.
/// </summary>
internal sealed class Capture : IDisposable
{
    public const int BudgetMs = 200;
    private const int F9 = 0x78;

    private readonly Session _session = new();
    private readonly object _gate = new();
    private readonly HashSet<DateTimeOffset> _late = [];
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
        var start = new ProcessStartInfo(path) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path) ?? "" };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        Process? process;
        var at = DateTimeOffset.Now;
        try { process = Process.Start(start); }
        catch (Win32Exception e) when (e.NativeErrorCode == 740) // ERROR_ELEVATION_REQUIRED
        {
            Notify(NoticeKind.Elevated, Notices.Elevated);
            return false;
        }
        if (process is null) return false;
        var window = IntPtr.Zero;
        for (var waited = 0; waited < 30000 && window == IntPtr.Zero && !process.HasExited; waited += 100)
        {
            window = Native.TopLevelWindows().FirstOrDefault(h => Native.ProcessOf(h) == process.Id);
            if (window == IntPtr.Zero) Thread.Sleep(100);
        }
        if (window == IntPtr.Zero)
        {
            Notify(NoticeKind.NotStarted, Notices.NotStarted);
            return false;
        }
        lock (_gate) _session.Add(new AppStarted(at, path, args, UiaWorker.Window(window)));
        ProgramPath = path;
        AppProcessId = process.Id;
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
        ProgramPath = Native.ImagePath(process);
        AppProcessId = (int)process;
        Begin();
        return true;
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

    public void AddRead(ElementFacts element, WindowFacts window, string name) => Use(s => { s.AddRead(element, window, name); return 0; });

    /// <summary>
    /// Writes the recording file and the policy change file into the folder and returns their paths. Without
    /// <paramref name="overwrite"/> an existing file is never replaced (IOException).
    /// </summary>
    public (string Recording, string PolicyChange) Save(string folder, string name, bool overwrite)
    {
        var program = ProgramPath ?? throw new InvalidOperationException("the program's file is not known, so no policy change can be made for it");
        string recording, change;
        lock (_gate)
        {
            recording = _session.ToFile(name).ToJson();
            change = _session.ToPolicyChange(program, Sha256(program)).ToJson();
        }
        var paths = (Path.Combine(folder, SaveNames.Recording(name)), Path.Combine(folder, SaveNames.PolicyChange(name)));
        Write(paths.Item1, recording, overwrite);
        Write(paths.Item2, change, overwrite);
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
        if (Native.ProcessOf(Native.WindowFromPoint(new Native.POINT { X = x, Y = y })) == _ownProcess) return;
        var job = Stopwatch.StartNew();
        var at = DateTimeOffset.Now;
        _worker.Post(() => Mouse(at, job, x, y)).Wait(BudgetMs);
    }

    private bool OnKeyDown(int vk, bool ctrl, bool alt, bool shift)
    {
        if (!_recording) return false;
        var kind = KeyRules.Kind(vk, ctrl, alt);
        if (kind == KeyKind.Modifier) return false;
        if (Native.ProcessOf(Native.GetForegroundWindow()) == _ownProcess) return false;
        var at = DateTimeOffset.Now;
        if (_readKey && vk == F9 && !ctrl && !alt && !shift)
        {
            _worker.Post(ReadAtPointer);
            return true;
        }
        if (kind == KeyKind.Printable)
        {
            // Typing: no wait, and the key itself goes no further than this line.
            _worker.Post(() => Key(at, null, KeyKind.Printable, null));
            return false;
        }
        var job = Stopwatch.StartNew();
        var chord = KeyRules.Chord(ctrl, alt, shift, KeyRules.KeyName(vk)!);
        _worker.Post(() => Key(at, job, kind, chord)).Wait(BudgetMs);
        return false;
    }

    // ---- The worker's thread. ----

    private void Mouse(DateTimeOffset at, Stopwatch job, int x, int y)
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
        if (d is null || d.ProcessId == _ownProcess) return;
        var window = UiaWorker.WindowOf(d, top);
        var down = new MouseDown(at, window, d.Facts, 1);
        LeaveField(down);
        var matches = _worker.CountMatches(window, LocatorRules.Condition(d.Facts), d.ProcessId);
        var late = job.ElapsedMilliseconds > BudgetMs;
        // Counted after the click went on, the element may be gone: recorded as it is, for the person to check.
        if (late && matches == 0) matches = 1;
        Add(down with { Matches = matches }, late, d.Facts);
    }

    /// <summary>A key on the focused element: typing (<paramref name="chord"/> null) or a key event.</summary>
    private void Key(DateTimeOffset at, Stopwatch? job, KeyKind kind, string? chord)
    {
        var d = _worker.Focused();
        if (d is null || d.ProcessId == _ownProcess) return;
        var window = UiaWorker.WindowOf(d, Native.GetForegroundWindow());
        var typing = kind == KeyKind.Printable || KeyRules.IsTyping(kind, KeyRules.Field(d.Facts));
        var key = new KeyDown(at, window, d.Facts, typing ? "" : chord ?? "", typing);
        LeaveField(key);
        Add(key, job is not null && !typing && job.ElapsedMilliseconds > BudgetMs, d.Facts);
        lock (_gate)
        {
            if (typing && _session.FieldBeingTyped is { } field && field.RuntimeId == d.Facts.RuntimeId && _fieldId != field.RuntimeId)
                (_fieldElement, _fieldId, _fieldWindow) = (d.Element, field.RuntimeId, window);
        }
    }

    private void ReadAtPointer()
    {
        if (!Native.GetCursorPos(out var point)) return;
        var top = Native.GetAncestor(Native.WindowFromPoint(point), Native.GA_ROOT);
        if (Native.ProcessOf(top) == _ownProcess) return;
        var d = _worker.At(point.X, point.Y);
        if (d is null || d.ProcessId == _ownProcess) return;
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

    private void LeaveFieldNow()
    {
        ElementFacts? field;
        lock (_gate) field = _session.FieldBeingTyped;
        if (field is not null) Leave(field, DateTimeOffset.Now);
    }

    private void Leave(ElementFacts field, DateTimeOffset at)
    {
        string? value = null, selection = null;
        // The secret check comes first, from the field's facts: a secret field's value is never asked for.
        if (!SecretRules.IsSecret(field) && _fieldElement is { } live && _fieldId == field.RuntimeId)
        {
            if (KeyRules.Field(field) == FieldKind.DropDown) selection = UiaWorker.ReadSelection(live);
            else value = UiaWorker.ReadValue(live);
        }
        var window = _fieldWindow ?? new WindowFacts("", "", "");
        (_fieldElement, _fieldId, _fieldWindow) = (null, "", null);
        lock (_gate) _session.Add(new FieldLeft(at, window, field, value, selection));
        Changed?.Invoke();
    }

    private void Add(Observation observation, bool late, ElementFacts element)
    {
        lock (_gate)
        {
            _session.Add(observation);
            if (late) _late.Add(observation.At);
        }
        if (late) Notify(NoticeKind.Late, Notices.Late(LocatorRules.Label(element)), always: true);
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
