using System.Runtime.InteropServices;

namespace Rpa.Recorder;

/// <summary>
/// The low-level mouse and keyboard hooks, on a thread of their own with a message loop (low-level hooks need one).
/// They only say when something happened and pass it on; what it was on is asked of UI Automation by the worker.
/// The callbacks hold the input while they run, so a callback that waits for the worker waits at most the budget.
/// Nothing a hook sees is logged or kept here.
/// </summary>
internal sealed class Hooks : IDisposable
{
    /// <summary>A left mouse button went down at this screen point; returns when the input may go on.</summary>
    public required Action<int, int> MouseDown { get; init; }
    public required Action MouseUp { get; init; }
    /// <summary>A key went down (virtual-key code, Ctrl, Alt, Shift, a Windows key); true keeps it from the application.</summary>
    public required Func<int, bool, bool, bool, bool, bool> KeyDown { get; init; }
    /// <summary>Any mouse or key event: for the hook watch.</summary>
    public required Action Seen { get; init; }

    private readonly ManualResetEventSlim _installed = new(false);
    private Thread? _thread;
    private uint _threadId;
    private IntPtr _mouseHook, _keyHook;
    // Kept in fields: Windows calls them for as long as the hooks are installed.
    private Native.HookProc? _mouseProc, _keyProc;

    public void Start()
    {
        if (_thread is not null) return;
        _thread = new Thread(Loop) { IsBackground = true, Name = "hooks" };
        _thread.Start();
        _installed.Wait(TimeSpan.FromSeconds(10));
    }

    /// <summary>Removes and installs the hooks again (Windows may have dropped them).</summary>
    public void Reinstall()
    {
        if (_threadId != 0) Native.PostThreadMessage(_threadId, Native.WM_APP, IntPtr.Zero, IntPtr.Zero);
    }

    public void Dispose()
    {
        if (_thread is null) return;
        Native.PostThreadMessage(_threadId, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        _thread.Join(TimeSpan.FromSeconds(5));
        _thread = null;
    }

    private void Loop()
    {
        _threadId = Native.GetCurrentThreadId();
        _mouseProc = MouseProc;
        _keyProc = KeyProc;
        Install();
        _installed.Set();
        while (Native.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.hwnd == IntPtr.Zero && msg.message == Native.WM_APP) { Uninstall(); Install(); continue; }
            Native.TranslateMessage(ref msg);
            Native.DispatchMessage(ref msg);
        }
        Uninstall();
    }

    private void Install()
    {
        var module = Native.GetModuleHandle(null);
        _mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _mouseProc!, module, 0);
        _keyHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _keyProc!, module, 0);
    }

    private void Uninstall()
    {
        if (_mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_mouseHook);
        if (_keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_keyHook);
        _mouseHook = _keyHook = IntPtr.Zero;
    }

    private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            try
            {
                Seen();
                var message = (int)wParam;
                if (message == Native.WM_LBUTTONDOWN)
                {
                    var info = Marshal.PtrToStructure<Native.MSLLHOOKSTRUCT>(lParam);
                    MouseDown(info.pt.X, info.pt.Y);
                }
                else if (message == Native.WM_LBUTTONUP) MouseUp();
            }
            catch (Exception) { /* a hook must always pass the input on */ }
        }
        return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            try
            {
                Seen();
                if ((int)wParam is Native.WM_KEYDOWN or Native.WM_SYSKEYDOWN)
                {
                    var vk = (int)Marshal.PtrToStructure<Native.KBDLLHOOKSTRUCT>(lParam).vkCode;
                    if (KeyDown(vk, Down(0x11), Down(0x12), Down(0x10), Down(0x5B) || Down(0x5C))) return (IntPtr)1;
                }
            }
            catch (Exception) { /* a hook must always pass the input on */ }
        }
        return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static bool Down(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
}
