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

    public static PolicyConsole Ask()
    {
        var asked = DateTime.UtcNow;
        if (AttachedProcesses() is not { } ids) return new PolicyConsole(null, TakesKeys: false);
        var others = ids.Where(id => id != (uint)Environment.ProcessId).Select(id => IsElevated(id, asked)).ToList();
        // Someone can press Enter in the console when it has a window, the window is on the desktop of a person who
        // is signed in (a service or a scheduled task runs on a window station nobody sees), and the tool's input is
        // that console and not a file or a pipe.
        var takesKeys = GetConsoleWindow() != 0 && Environment.UserInteractive && !Console.IsInputRedirected;
        return new PolicyConsole(others, takesKeys);
    }

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
