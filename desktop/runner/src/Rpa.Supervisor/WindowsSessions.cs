using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>The machine's sessions, through the Remote Desktop Services API (wtsapi32).</summary>
internal sealed class WindowsSessions : ISessions
{
    private static readonly TimeSpan SignOutLimit = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);

    /// <summary>Every session of the user in any state, the console session included. A local and a domain user of
    /// the same name both count: listing too much makes the supervisor refuse, never sign out a person.</summary>
    public IReadOnlyList<SessionInfo> ForUser(string user) =>
        All().Where(s => string.Equals(s.User, user, StringComparison.OrdinalIgnoreCase)).ToArray();

    /// <summary>Signs the session out without waiting in Windows, then waits up to 30 s until it is no longer listed.
    /// Throws when Windows refuses or the session is still there.</summary>
    public async Task SignOutAsync(uint sessionId, CancellationToken ct)
    {
        if (All().FirstOrDefault(s => s.Id == sessionId) is not { } session) return;
        if (!WTSLogoffSession(IntPtr.Zero, sessionId, false))
        {
            var error = new Win32Exception();
            if (!Listed(session)) return;
            throw new Win32Exception(error.NativeErrorCode, $"Windows did not sign session {sessionId} out: {error.Message}");
        }
        var waited = Stopwatch.StartNew();
        while (Listed(session))
        {
            if (waited.Elapsed > SignOutLimit)
                throw new TimeoutException($"Session {sessionId} was still there {SignOutLimit.TotalSeconds:0} s after it was signed out.");
            await Task.Delay(Poll, ct);
        }
    }

    // A session is told apart by its id and its logon time together: Windows reuses ids.
    private static bool Listed(SessionInfo session) =>
        All().Any(s => s.Id == session.Id && s.LogonTime == session.LogonTime);

    /// <summary>Every session that has a user.</summary>
    private static List<SessionInfo> All()
    {
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count)) throw new Win32Exception();
        var ids = new List<uint>(count);
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var i = 0; i < count; i++) ids.Add(Marshal.PtrToStructure<WTS_SESSION_INFO>(buffer + i * size).SessionId);
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
        var sessions = new List<SessionInfo>(ids.Count);
        foreach (var id in ids)
            if (Query(id) is { } session) sessions.Add(session);
        return sessions;
    }

    // One session's user, state and logon time, read together; null when it has no user or is gone since the listing.
    private static SessionInfo? Query(uint id)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, id, WTSSessionInfoEx, out var buffer, out _)) return null;
        try
        {
            var info = Marshal.PtrToStructure<WTSINFOEXW>(buffer);
            if (info.Level != 1 || string.IsNullOrEmpty(info.Data.UserName)) return null;
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
