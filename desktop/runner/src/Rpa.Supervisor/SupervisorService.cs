using System.ServiceProcess;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>
/// The Windows service "RPA Supervisor" (SYSTEM). It reads install.json; when mode is unattended it runs the port proxy
/// in front of the runner and the browser host, which signs the bot user in when n8n connects and out when the work is
/// done (SessionManager). With any other mode it writes one line to its log and does nothing. A wrong install.json or a
/// port it cannot listen on stops it at start. On stop it ends the proxy's run first, which also cancels a sign-in in
/// progress, and then signs its session out.
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
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            _log.Failure(null, $"The RPA Supervisor failed: {(e.ExceptionObject as Exception)?.Message}");
    }

    /// <summary>Where the installer keeps install.json: the install directory, which only administrators can change.</summary>
    internal static string InstallFilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RPA Runner", "install.json");

    private static string DataDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RPA Runner");

    private static string StateFile => Path.Combine(DataDirectory, "supervisor-state.json");

    private static string LogFile => Path.Combine(DataDirectory, "logs", "supervisor.log");

    protected override void OnStart(string[] args)
    {
        SupervisorOptions? options;
        try
        {
            options = InstallFile.ToOptions(File.ReadAllText(InstallFilePath), StateFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            throw Refuse($"The RPA Supervisor cannot read {InstallFilePath}: {e.Message}");
        }
        if (options is null)
        {
            _log.Info($"{InstallFilePath} does not set {InstallFile.Mode} to \"{InstallFile.Unattended}\"; the RPA Supervisor does nothing.");
            return;
        }

        var sessions = new WindowsSessions();
        _manager = new SessionManager(sessions, new RdpHostProcess(sessions, _log), options, _log, TimeProvider.System);
        // RunAsync binds every listener before its first wait, so a port it cannot listen on fails the start.
        var proxy = new PortProxy(_manager, options, _log).RunAsync(_stop.Token);
        if (proxy.IsFaulted) throw Refuse($"The RPA Supervisor cannot listen: {proxy.Exception!.GetBaseException().Message}");
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
            _proxy?.Wait(StopLimit);
        }
        catch (AggregateException)
        {
            // Logged by WatchAsync.
        }
        try
        {
            if (!_manager.StopAsync().Wait(StopLimit))
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

    private InvalidOperationException Refuse(string message)
    {
        _log.Failure(null, message);
        ExitCode = 1;
        return new InvalidOperationException(message);
    }
}
