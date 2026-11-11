using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>The machine's sessions, through the Remote Desktop Services API (wtsapi32).</summary>
internal sealed class WindowsSessions : ISessions
{
    private static readonly TimeSpan SignOutLimit = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SignOutRepeat = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan RecentSignOut = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<uint, long> _signOuts = new();

    /// <summary>Every session of the user in any state, the console session included. A local and a domain user of
    /// the same name both count: listing too much makes the supervisor refuse, never sign out a person. Throws when a
    /// session that is still listed cannot be read.</summary>
    public IReadOnlyList<SessionInfo> ForUser(string user) =>
        All().Where(s => string.Equals(s.User, user, StringComparison.OrdinalIgnoreCase)).ToArray();

    /// <summary>Signs the session out without waiting in Windows, then waits up to 30 s until it is no longer listed,
    /// asking again every 5 s (a session in the middle of its logon may not take the first request). Throws when
    /// Windows refuses or the session is still there.</summary>
    public async Task SignOutAsync(uint sessionId, CancellationToken ct)
    {
        if (All().FirstOrDefault(s => s.Id == sessionId) is not { } session) return;
        _signOuts[sessionId] = Environment.TickCount64;
        var waited = Stopwatch.StartNew();
        var asked = TimeSpan.Zero;
        LogOff(session);
        while (Listed(session))
        {
            if (waited.Elapsed > SignOutLimit)
                throw new TimeoutException($"Session {sessionId} was still there {SignOutLimit.TotalSeconds:0} s after it was signed out.");
            if (waited.Elapsed - asked >= SignOutRepeat)
            {
                asked = waited.Elapsed;
                try
                {
                    LogOff(session);
                }
                catch (Win32Exception)
                {
                    // The first request may still be under way; the wait decides.
                }
            }
            await Task.Delay(Poll, ct);
        }
    }

    /// <summary>Whether this process signed the session out in the last minute: its Remote Desktop connection then
    /// ends as a matter of course.</summary>
    public bool SignedOutRecently(uint sessionId) =>
        _signOuts.TryGetValue(sessionId, out var at) && Environment.TickCount64 - at < RecentSignOut.TotalMilliseconds;

    private static void LogOff(SessionInfo session)
    {
        if (WTSLogoffSession(IntPtr.Zero, session.Id, false)) return;
        var error = new Win32Exception();
        if (!Listed(session)) return;
        throw new Win32Exception(error.NativeErrorCode, $"Windows did not sign session {session.Id} out: {error.Message}");
    }

    // A session is told apart by its id and its logon time together: Windows reuses ids.
    private static bool Listed(SessionInfo session) =>
        All().Any(s => s.Id == session.Id && s.LogonTime == session.LogonTime);

    /// <summary>Every session that has a user.</summary>
    private static List<SessionInfo> All()
    {
        var sessions = new List<SessionInfo>();
        foreach (var id in Ids())
            if (Query(id) is { } session) sessions.Add(session);
        return sessions;
    }

    private static List<uint> Ids()
    {
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count)) throw new Win32Exception();
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            var ids = new List<uint>(count);
            for (var i = 0; i < count; i++) ids.Add(Marshal.PtrToStructure<WTS_SESSION_INFO>(buffer + i * size).SessionId);
            return ids;
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    // One session's user, state and logon time, read together; null when it has no user or is gone since the listing.
    // A session that is still listed but cannot be read throws: it might be the user's.
    private static SessionInfo? Query(uint id)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, id, WTSSessionInfoEx, out var buffer, out _))
        {
            var error = new Win32Exception();
            if (!Ids().Contains(id)) return null;
            throw new Win32Exception(error.NativeErrorCode, $"Session {id} could not be read: {error.Message}");
        }
        try
        {
            var info = Marshal.PtrToStructure<WTSINFOEXW>(buffer);
            if (info.Level != 1) throw new Win32Exception($"Session {id} could not be read: Windows answered with level {info.Level}.");
            if (string.IsNullOrEmpty(info.Data.UserName)) return null;
            var state = info.Data.SessionState switch
            {
                WTSActive => SessionState.Active,
                WTSDisconnected => SessionState.Disconnected,
                _ => SessionState.Other,
            };
            return new SessionInfo(id, info.Data.UserName, state, new DateTimeOffset(DateTime.FromFileTimeUtc(info.Data.LogonTime)));
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    private const int WTSSessionInfoEx = 25;
    private const int WTSActive = 0;
    private const int WTSDisconnected = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO
    {
        public uint SessionId;
        public IntPtr pWinStationName;
        public int State;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WTSINFOEXW
    {
        public uint Level;
        public WTSINFOEX_LEVEL1_W Data;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WTSINFOEX_LEVEL1_W
    {
        public uint SessionId;
        public int SessionState;
        public int SessionFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string WinStationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string UserName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string DomainName;
        public long LogonTime;
        public long ConnectTime;
        public long DisconnectTime;
        public long LastInputTime;
        public long CurrentTime;
        public uint IncomingBytes;
        public uint OutgoingBytes;
        public uint IncomingFrames;
        public uint OutgoingFrames;
        public uint IncomingCompressedBytes;
        public uint OutgoingCompressedBytes;
    }

    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSEnumerateSessionsW")]
    private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);

    [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSQuerySessionInformationW")]
    private static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int infoClass, out IntPtr buffer, out int bytes);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSLogoffSession(IntPtr server, uint session, bool wait);
}
