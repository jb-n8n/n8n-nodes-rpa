using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>
/// Signs the bot user in by starting a Remote Desktop host process (RpaSupervisor.exe rdp-host, RdpHostWindow), one
/// per connection, in a job object that ends it when the service ends. The host gets the user name and the password on
/// its standard input, never on its command line, and answers with RdpHostEvent lines. A host that writes nothing for
/// 30 s is ended. ConnectAsync waits at most 60 s for the session (a first sign-in after boot or of a new user takes
/// long; ReadySeconds is 90). When an attempt fails or is cancelled, the host is ended, and ConnectAsync throws only
/// after it has ended and no session of the user that began during the attempt is Active (at most about 10 s more), so
/// that the session manager can tell a half-made session from a person's.
/// </summary>
internal sealed class RdpHostProcess(WindowsSessions sessions, ISupervisorLog log) : IRdpHost
{
    private static readonly TimeSpan ConnectLimit = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan EndLimit = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    public async Task<IRdpConnection> ConnectAsync(string user, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var startedAt = DateTimeOffset.UtcNow;
        var host = Host.Start(user, LsaSecret.Read(LsaSecret.BotPasswordName), sessions, log);
        try
        {
            using var limit = new CancellationTokenSource(ConnectLimit);
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct, limit.Token);
            var sessionId = await host.Active.WaitAsync(wait.Token);
            return new Connection(host, sessionId);
        }
        catch (Exception e)
        {
            await host.EndAsync();
            await WaitUntilNotActiveAsync(user, startedAt);
            if (e is OperationCanceledException && !ct.IsCancellationRequested)
                throw RdpFailures.WithoutDisconnect(SessionFailure.Timeout,
                    $"{user} was not signed in within {ConnectLimit.TotalSeconds:0} s.", host.Reports);
            throw;
        }
    }

    // After a failed attempt: waits until no session of the user that began during it is Active (the host's end drops
    // its connection, and the session becomes Disconnected).
    private async Task WaitUntilNotActiveAsync(string user, DateTimeOffset startedAt)
    {
        var waited = Stopwatch.StartNew();
        while (true)
        {
            SessionInfo? session;
            try
            {
                session = sessions.ForUser(user).FirstOrDefault(s => s.State == SessionState.Active && s.LogonTime >= startedAt);
            }
            catch (Win32Exception e)
            {
                log.Failure(null, $"The sessions of {user} could not be listed after a failed sign-in: {e.Message}");
                return;
            }
            if (session is null) return;
            if (waited.Elapsed > EndLimit)
            {
                log.Failure(null, $"Session {session.Id} of {user} is still Active {EndLimit.TotalSeconds:0} s after its Remote Desktop host ended.");
                return;
            }
            await Task.Delay(Poll);
        }
    }

    private sealed class Connection(Host host, uint sessionId) : IRdpConnection
    {
        public uint SessionId => sessionId;
        public Task Closed => host.Closed;
        public ValueTask DisposeAsync() => new(host.StopAsync());
    }

    /// <summary>One host process and what it said.</summary>
    private sealed class Host
    {
        private const int MaxErrorLines = 5;

        private readonly Process _process;
        private readonly string _user;
        private readonly WindowsSessions _sessions;
        private readonly ISupervisorLog _log;
        private readonly TaskCompletionSource<uint> _active = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long _lastOutput = Environment.TickCount64;
        private string? _failed;
        private string? _dialog;
        private int? _logonError;
        private int? _warning;

        private Host(Process process, string user, WindowsSessions sessions, ISupervisorLog log)
        {
            _process = process;
            _user = user;
            _sessions = sessions;
            _log = log;
            // A failure nobody waits for any more (the attempt timed out first) is not an unobserved exception.
            _active.Task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            Exited = ReadAsync();
            _ = WatchSilenceAsync();
        }

        /// <summary>The session id once the session is Active; a SessionException when the connection ends first.</summary>
        public Task<uint> Active => _active.Task;

        /// <summary>Completes when the connection ends: the host reported a disconnect, or it ended.</summary>
        public Task Closed => _closed.Task;

        /// <summary>Completes when the process has ended, all it wrote is read and it is disposed.</summary>
        public Task Exited { get; }

        /// <summary>The first message box the client showed, and its last logon error and warning.</summary>
        public ClientReports Reports => new(_dialog, _logonError, _warning);

        public static Host Start(string user, string password, WindowsSessions sessions, ISupervisorLog log)
        {
            if (password.AsSpan().IndexOfAny('\r', '\n') >= 0)
                throw new SessionException(SessionFailure.NoPassword,
                    $"The stored password of {user} holds a line break, which the RPA Supervisor cannot pass to its Remote Desktop host.");
            var info = new ProcessStartInfo(Environment.ProcessPath ?? throw new InvalidOperationException("The program's path is unknown."))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = Utf8,
                StandardOutputEncoding = Utf8,
                StandardErrorEncoding = Utf8,
                WorkingDirectory = AppContext.BaseDirectory,
            };
            info.ArgumentList.Add(Program.RdpHostMode);
            Process process;
            try
            {
                process = Process.Start(info) ?? throw new InvalidOperationException("No process was started.");
            }
            catch (Exception e) when (e is Win32Exception or InvalidOperationException)
            {
                throw new SessionException(SessionFailure.HostExited, $"The Remote Desktop host could not be started: {e.Message}");
            }
            try
            {
                HostJob.Add(process);
            }
            catch (Win32Exception e)
            {
                Kill(process);
                process.Dispose();
                throw new SessionException(SessionFailure.HostExited, $"The Remote Desktop host could not be put in the service's job object: {e.Message}");
            }
            var host = new Host(process, user, sessions, log);
            try
            {
                process.StandardInput.WriteLine(user);
                process.StandardInput.WriteLine(password);
                process.StandardInput.Flush();
            }
            catch (Exception e) when (e is IOException or InvalidOperationException)
            {
                // The host has ended already (and its process may be disposed); its end says why.
            }
            return host;
        }

        /// <summary>Ends the host after a failed or cancelled attempt and waits for it.</summary>
        public async Task EndAsync()
        {
            Kill(_process);
            await WaitForExitAsync();
        }

        /// <summary>Ends the connection: closing standard input makes the host disconnect and exit; one that does not
        /// within 5 s is ended.</summary>
        public async Task StopAsync()
        {
            try
            {
                _process.StandardInput.Close();
            }
            catch (Exception e) when (e is IOException or InvalidOperationException)
            {
                // It has ended already.
            }
            if (!await WaitForExitAsync())
            {
                Kill(_process);
                await WaitForExitAsync();
            }
        }

        private async Task<bool> WaitForExitAsync()
        {
            try
            {
                await Exited.WaitAsync(EndLimit);
                return true;
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        // Reads the host's lines until it ends, then disposes the process.
        private async Task ReadAsync()
        {
            var exitCode = "unknown";
            try
            {
                var errors = ReadErrorsAsync();
                try
                {
                    while (await _process.StandardOutput.ReadLineAsync() is { } line)
                    {
                        Interlocked.Exchange(ref _lastOutput, Environment.TickCount64);
                        Handle(line);
                    }
                }
                catch (IOException)
                {
                }
                await errors;
                await _process.WaitForExitAsync();
                exitCode = _process.ExitCode.ToString(CultureInfo.InvariantCulture);
            }
            finally
            {
                _process.Dispose();
                _active.TrySetException(RdpFailures.WithoutDisconnect(SessionFailure.HostExited,
                    $"The Remote Desktop host for {_user} ended (exit code {exitCode}{(_failed is null ? "" : ": " + _failed)}) before the session was ready.",
                    Reports));
                _closed.TrySetResult();
            }
        }

        private void Handle(string line)
        {
            switch (RdpHostEvent.Parse(line))
            {
                case RdpHostEvent.Active active:
                    _active.TrySetResult(active.SessionId);
                    break;
                case RdpHostEvent.Disconnected d:
                    if (_active.Task.IsCompletedSuccessfully) LogEnd(_active.Task.Result, d);
                    _active.TrySetException(RdpFailures.FromDisconnect(_user, d.Reason, d.Extended, d.Description, Reports));
                    _closed.TrySetResult();
                    break;
                case RdpHostEvent.Dialog d:
                    _dialog ??= d.Text;
                    _log.Failure(null, $"The Remote Desktop client showed a message, which was {(d.Pressed ? "answered with its default button" : "closed")}: \"{d.Text}\"");
                    break;
                case RdpHostEvent.LogonError e:
                    _logonError = e.Code;
                    _log.Info($"The Remote Desktop client of {_user} reported logon error {e.Code}.");
                    break;
                case RdpHostEvent.Warning w:
                    _warning = w.Code;
                    _log.Info($"The Remote Desktop client of {_user} reported warning {w.Code}.");
                    break;
                case RdpHostEvent.Failed f:
                    _failed ??= f.Text;
                    _log.Failure(null, $"The Remote Desktop host for {_user} failed: {f.Text}");
                    break;
                case RdpHostEvent.Alive:
                    break;
                default:
                    _log.Info($"The Remote Desktop host wrote a line that is not an event: {Cut(line)}");
                    break;
            }
        }

        // After the supervisor's own sign-out the connection ends as a matter of course, with texts that read like an
        // error ("an internal error has occurred"); only an end without that sign-out is told in full.
        private void LogEnd(uint sessionId, RdpHostEvent.Disconnected d)
        {
            if (_sessions.SignedOutRecently(sessionId))
                _log.Info($"The Remote Desktop connection of session {sessionId} ended after its sign-out.");
            else
                _log.Info($"The Remote Desktop connection of session {sessionId} ended without a sign-out by the RPA Supervisor " +
                    $"(disconnect reason {d.Reason}, extended reason {d.Extended}{(d.Description.Length > 0 ? ": " + d.Description : "")}).");
        }

        // The host writes nothing on its standard error unless the runtime fails; the first lines go to the log.
        private async Task ReadErrorsAsync()
        {
            var lines = 0;
            try
            {
                while (await _process.StandardError.ReadLineAsync() is { } line)
                    if (lines++ < MaxErrorLines && line.Trim().Length > 0)
                        _log.Failure(null, $"The Remote Desktop host wrote an error: {Cut(line)}");
            }
            catch (IOException)
            {
            }
        }

        private async Task WatchSilenceAsync()
        {
            while (!Exited.IsCompleted)
            {
                await Task.WhenAny(Exited, Task.Delay(TimeSpan.FromSeconds(1)));
                if (Exited.IsCompleted) return;
                if (Environment.TickCount64 - Interlocked.Read(ref _lastOutput) > SilenceLimit.TotalMilliseconds)
                {
                    _log.Failure(null, $"The Remote Desktop host for {_user} wrote nothing for {SilenceLimit.TotalSeconds:0} s and is ended.");
                    Kill(_process);
                    return;
                }
            }
        }

        private static void Kill(Process process)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception e) when (e is InvalidOperationException or Win32Exception or NotSupportedException)
            {
                // It has ended already.
            }
        }

        private static string Cut(string text) => text.Length <= 300 ? text : text[..300];
    }

    /// <summary>The job object of every host process: when the service's process ends, Windows ends them too.</summary>
    private static class HostJob
    {
        private const uint KillOnJobClose = 0x2000;
        private const int ExtendedLimitInformation = 9;
        private static readonly Lazy<IntPtr> Job = new(Create);

        public static void Add(Process process)
        {
            if (!AssignProcessToJobObject(Job.Value, process.Handle)) throw new Win32Exception();
        }

        // Never closed: the handle closes with the service's process, and that ends the hosts.
        private static IntPtr Create()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = { LimitFlags = KillOnJobClose } };
            if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
            {
                var error = new Win32Exception();
                CloseHandle(job);
                throw error;
            }
            return job;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
