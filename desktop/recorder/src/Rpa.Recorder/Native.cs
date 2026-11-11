using System.Runtime.InteropServices;
using System.Text;

namespace Rpa.Recorder;

/// <summary>The Windows calls the recorder makes: hooks, windows, processes. It sends no input.</summary>
internal static class Native
{
    public const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    public const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    public const uint WM_QUIT = 0x0012, WM_APP = 0x8000;
    public const uint GA_ROOT = 2;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint TOKEN_QUERY = 0x0008;
    public const int TokenElevation = 20;

    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; public uint priv; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize, dwTime; }

    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string? currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION { public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, out uint info, uint length, out uint returned);

    public static string ClassOf(IntPtr hwnd) { var sb = new StringBuilder(256); GetClassName(hwnd, sb, sb.Capacity); return sb.ToString(); }
    public static string TitleOf(IntPtr hwnd) { var sb = new StringBuilder(512); GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }
    public static uint ProcessOf(IntPtr hwnd) { GetWindowThreadProcessId(hwnd, out var pid); return pid; }

    public static List<IntPtr> TopLevelWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, _) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    /// <summary>The full path of a process's program, also for a process that runs as administrator; null when Windows
    /// does not say.</summary>
    public static string? ImagePath(uint processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            var size = (uint)sb.Capacity;
            return QueryFullProcessImageName(process, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
        }
        finally { CloseHandle(process); }
    }

    /// <summary>
    /// A process's id, its parent's id (ProcessBasicInformation), its program file (QueryFullProcessImageName) and its
    /// start time (GetProcessTimes), all with the least access Windows has (PROCESS_QUERY_LIMITED_INFORMATION). Null
    /// when the process cannot be opened; a part that cannot be read is null (the parent id 0).
    /// </summary>
    public static Rpa.Recorder.Core.ProcessFacts? Describe(int processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            var info = new PROCESS_BASIC_INFORMATION();
            var parent = NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(), out _) == 0
                ? (int)info.InheritedFromUniqueProcessId : 0;
            var sb = new StringBuilder(1024);
            var size = (uint)sb.Capacity;
            var image = QueryFullProcessImageName(process, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
            DateTimeOffset? started = GetProcessTimes(process, out var creation, out _, out _, out _) ? DateTimeOffset.FromFileTime(creation) : null;
            return new Rpa.Recorder.Core.ProcessFacts(processId, parent, image, started);
        }
        finally { CloseHandle(process); }
    }

    /// <summary>
    /// Starts a program with none of the recorder's handles: not its standard input, output or error (a program started
    /// with them would keep them open after the recorder ends), nor any other. Returns the process's handle, which is
    /// signalled when it exits and keeps its id from being given to another process, and its id. Win32Exception when it
    /// does not start (740: it needs administrator rights).
    /// </summary>
    public static (Microsoft.Win32.SafeHandles.SafeWaitHandle Process, int Id) Start(string path, IReadOnlyList<string> args, string? directory)
    {
        var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        var commandLine = new StringBuilder(Rpa.Recorder.Core.CommandLine.Join(path, args));
        if (!CreateProcess(path, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, directory, ref startup, out var started))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        CloseHandle(started.hThread);
        return (new Microsoft.Win32.SafeHandles.SafeWaitHandle(started.hProcess, ownsHandle: true), started.dwProcessId);
    }

    /// <summary>Whether Windows keeps a window out of sight (DWMWA_CLOAKED), as it does its text input host.</summary>
    public static bool IsCloaked(IntPtr hwnd) => DwmGetWindowAttribute(hwnd, 14, out var cloaked, sizeof(int)) == 0 && cloaked != 0;

    /// <summary>
    /// A handle to a process that is signalled when it exits (SYNCHRONIZE, with the least query access). While it is
    /// open, Windows does not give the process's id to another process. Null when the process cannot be opened.
    /// </summary>
    public static Microsoft.Win32.SafeHandles.SafeWaitHandle? OpenToWatch(uint processId)
    {
        var process = OpenProcess(0x00100000 | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        return process == IntPtr.Zero ? null : new Microsoft.Win32.SafeHandles.SafeWaitHandle(process, ownsHandle: true);
    }

    /// <summary>Whether a process runs elevated (as administrator). A process whose token this one may not read counts as
    /// elevated: that is what a normal user's program sees of an administrator's.</summary>
    public static bool IsElevated(uint processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return true;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return true;
            try { return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(uint), out _) && elevated != 0; }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    /// <summary>The time of the last input the system had, on the clock of <see cref="Environment.TickCount64"/>.</summary>
    public static long LastInputMs()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return 0;
        var now = Environment.TickCount64;
        return now - unchecked((uint)Environment.TickCount - info.dwTime);
    }
}
