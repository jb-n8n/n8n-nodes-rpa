using System.Diagnostics;
using System.ServiceProcess;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>
/// The Windows service "RPA Supervisor" (SYSTEM). It reads install.json; when mode is unattended it runs the port proxy
/// in front of the runner and the browser host, which signs the bot user in when n8n connects and out when the work is
/// done (SessionManager). With any other mode it writes one line to its log and does nothing. Its log and state file
/// are in %ProgramData%\RPA Runner\supervisor\, which the installer creates and only SYSTEM and administrators can
/// write; without that folder, a wrong install.json or a port it cannot listen on, it does not start, and says why in
/// one line (in the Windows event log when the folder is missing, in its log otherwise). On stop it ends the proxy's
/// run first, which also cancels a sign-in in progress, and then signs its session out, within 60 s in all.
/// </summary>
internal sealed class SupervisorService : ServiceBase
{
    public const string Name = "RPA Supervisor";

    private static readonly TimeSpan StopLimit = TimeSpan.FromSeconds(60);

    private readonly CancellationTokenSource _stop = new();
    private readonly FileSupervisorLog _log = new(LogFile, TimeProvider.System);
    private SessionManager? _manager;
    private Task? _proxy;
    private int _stopped;

    public SupervisorService()
    {
        ServiceName = Name;
        CanStop = true;
        CanShutdown = true;
        CanPauseAndContinue = false;
        // Start failures are written once, by the service itself, without a stack trace.
        AutoLog = false;
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            _log.Failure(null, $"The RPA Supervisor failed: {(e.ExceptionObject as Exception)?.Message}");
    }

    /// <summary>Where the installer keeps install.json: the install directory, which only administrators can change.</summary>
    internal static string InstallFilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RPA Runner", "install.json");

    /// <summary>The service's own folder: the installer creates it for SYSTEM and administrators only.</summary>
    internal static string SupervisorDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RPA Runner", "supervisor");

    private static string StateFile => Path.Combine(SupervisorDirectory, "supervisor-state.json");

    private static string LogFile => Path.Combine(SupervisorDirectory, "supervisor.log");

    protected override void OnStart(string[] args)
    {
        // A folder the service made itself would take the rights of the folder above it, which the bot user can write to.
        if (!Directory.Exists(SupervisorDirectory))
            throw Refuse($"The RPA Supervisor did not start: its folder {SupervisorDirectory} is missing. Run the installer again to create it.",
                inEventLog: true);

        SupervisorOptions? options;
        try
        {
            options = InstallFile.ToOptions(File.ReadAllText(InstallFilePath), StateFile, Environment.MachineName);
        }
        catch (InvalidDataException e)
        {
            throw Refuse($"The RPA Supervisor did not start: {e.Message}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw Refuse($"The RPA Supervisor did not start: {InstallFilePath} could not be read: {e.Message}");
        }
        if (options is null)
        {
            _log.Info($"{InstallFilePath} does not set {InstallFile.Mode} to \"{InstallFile.Unattended}\"; the RPA Supervisor does nothing.");
            return;
        }

        var sessions = new WindowsSessions();
        _manager = new SessionManager(sessions, new RdpHostProcess(sessions, _log), new RemoteDesktopService(), options, _log,
            TimeProvider.System);
        // RunAsync binds every listener before its first wait, so a port it cannot listen on fails the start.
        var proxy = new PortProxy(_manager, options, _log).RunAsync(_stop.Token);
        if (proxy.IsFaulted) throw Refuse($"The RPA Supervisor did not start: it cannot listen: {proxy.Exception!.GetBaseException().Message}");
        _proxy = proxy;
        _ = WatchAsync(proxy);

        var ports = string.Join(", ", options.Ports.Select(p => $"{p.ListenPort} to 127.0.0.1:{p.TargetPort}"));
        _log.Info($"The RPA Supervisor started for {options.User}: it listens on {string.Join(", ", options.ListenAddresses)} " +
            $"and passes port {ports}; the session is signed out after {options.IdleSeconds} s without a connection.");
    }

    protected override void OnStop() => Shutdown();

    protected override void OnShutdown() => Shutdown();

    private void Shutdown()
    {
        if (_manager is null || Interlocked.Exchange(ref _stopped, 1) == 1) return;
        var stopping = Stopwatch.StartNew();
        TimeSpan Left() => StopLimit - stopping.Elapsed is var left && left > TimeSpan.Zero ? left : TimeSpan.Zero;
        try
        {
            RequestAdditionalTime((int)StopLimit.TotalMilliseconds);
        }
        catch (InvalidOperationException)
        {
            // Not in a state that takes more time (the machine is shutting down); go on within what Windows gives.
        }
        _stop.Cancel();
        try
        {
            _proxy?.Wait(Left());
        }
        catch (AggregateException)
        {
            // Logged by WatchAsync.
        }
        try
        {
            if (!_manager.StopAsync().Wait(Left()))
                _log.Failure(null, $"Signing the session out did not finish within {StopLimit.TotalSeconds:0} s of the stop.");
        }
        catch (AggregateException e)
        {
            _log.Failure(null, $"Signing the session out on stop failed: {e.GetBaseException().Message}");
        }
        _log.Info("The RPA Supervisor stopped.");
    }

    // The proxy serves until the stop; if it ends before, the service stops with an error.
    private async Task WatchAsync(Task proxy)
    {
        try
        {
            await proxy;
        }
        catch (Exception e) when (!_stop.IsCancellationRequested)
        {
            _log.Failure(null, $"The RPA Supervisor's listener failed: {e.Message}");
            ExitCode = 1;
            Stop();
        }
    }

    // A start that does not go ahead: one line in the service's log, or in the Windows event log when there is no log
    // folder. Program.Main ends the process quietly after it.
    private StartRefused Refuse(string message, bool inEventLog = false)
    {
        if (inEventLog)
        {
            try
            {
                EventLog.WriteEntry(message, EventLogEntryType.Error);
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or System.Security.SecurityException)
            {
                // Nowhere left to say it; the service's state and exit code still show the failed start.
            }
        }
        else
        {
            _log.Failure(null, message);
        }
        ExitCode = 1;
        return new StartRefused(message);
    }
}

/// <summary>A start of the service that did not go ahead; its reason is logged already.</summary>
internal sealed class StartRefused(string message) : Exception(message);
