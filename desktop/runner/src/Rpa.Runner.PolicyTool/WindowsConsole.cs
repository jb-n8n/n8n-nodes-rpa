using System.Runtime.InteropServices;
using Rpa.Runner.Core.Policy;

/// <summary>
/// What Windows says about the console RpaPolicy.exe runs in. It only collects the facts; what follows from them
/// (whether <c>--yes</c> and <c>--policy</c> are honoured, whether the tool waits for Enter) is decided in
/// <see cref="PolicyConsole"/>.
/// </summary>
internal static class WindowsConsole
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int TokenElevation = 20;
    private const int StandardOutput = -11;

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ScreenBufferInfo
    {
        public Coord Size, Cursor;
        public ushort Attributes;
        public short WindowLeft, WindowTop, WindowRight, WindowBottom;
        public Coord MaximumWindowSize;
    }

    public static PolicyConsole Ask()
    {
        var asked = DateTime.UtcNow;
        if (AttachedProcesses() is not { } ids) return new PolicyConsole(null, TakesKeys: false, Buffer: null);
        var others = ids.Where(id => id != (uint)Environment.ProcessId).Select(id => IsElevated(id, asked)).ToList();
        // The three facts behind the wait for Enter: the console has a window, the tool runs on the window station of
        // a signed-in desktop (a service, and a scheduled task that runs whether a user is signed in or not, run on
        // another one), and the tool's input is that console and not a file or a pipe. Whether the window is visible
        // is not asked.
        var takesKeys = GetConsoleWindow() != 0 && Environment.UserInteractive && !Console.IsInputRedirected;
        return new PolicyConsole(others, takesKeys, Buffer());
    }

    /// <summary>The size of the screen buffer behind the tool's standard output, or null when that is not a console
    /// (Windows then has no buffer to tell about).</summary>
    private static (int Columns, int Rows)? Buffer() =>
        GetConsoleScreenBufferInfo(GetStdHandle(StandardOutput), out var info) ? (info.Size.X, info.Size.Y) : null;

    /// <summary>The ids of the processes attached to this console, the tool's own among them; null without a console.</summary>
    private static uint[]? AttachedProcesses()
    {
        var ids = new uint[16];
        while (true)
        {
            var count = GetConsoleProcessList(ids, (uint)ids.Length);
            if (count == 0) return null;
            if (count <= ids.Length) return ids[..(int)count];
            ids = new uint[count];
        }
    }

    /// <summary>
    /// True when the process can be opened and its token says it is elevated. Anything that cannot be opened or read
    /// counts as not elevated, and so does a process that started after the list was read: its id was given out
    /// again, so it is not the process that was listed.
    /// </summary>
    private static bool IsElevated(uint id, DateTime listed)
    {
        var process = OpenProcess(ProcessQueryLimitedInformation, false, id);
        if (process == 0) return false;
        try
        {
            if (!GetProcessTimes(process, out var created, out _, out _, out _) || DateTime.FromFileTimeUtc(created) > listed) return false;
            if (!OpenProcessToken(process, TokenQuery, out var token)) return false;
            try
            {
                return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(int), out _) && elevated != 0;
            }
            finally
            {
                CloseHandle(token);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

    [DllImport("kernel32.dll")]
    private static extern nint GetConsoleWindow();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(nint output, out ScreenBufferInfo info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(nint process, out long created, out long exited, out long kernel, out long user);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(nint token, int kind, out int value, int length, out int needed);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);
}
