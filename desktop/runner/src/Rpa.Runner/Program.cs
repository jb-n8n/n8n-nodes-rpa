using System.Reflection;
using Rpa.Runner.Core;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Windows;

// RPA desktop runner: listens on wss://<bind>:<port>/rpa/v1 and drives this Windows session's desktop for n8n.
if (args is ["--help"] or ["-h"] or ["/?"])
{
    Console.WriteLine(RunnerOptions.Usage);
    return 0;
}

RunnerOptions options;
try
{
    options = RunnerOptions.Parse(args, Environment.GetEnvironmentVariable);
    // The token now lives in options only; drop it from this process's environment as well.
    Environment.SetEnvironmentVariable("RPA_RUNNER_TOKEN", null);
}
catch (RunnerOptions.InvalidOptionsException e)
{
    Console.Error.WriteLine($"RPA runner: {e.Message}");
    Console.Error.WriteLine(RunnerOptions.Usage);
    return 2;
}

var version = typeof(RunnerHost).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "0.0.0";
var paths = new WindowsPathSecurity();
paths.CreatePrivateDirectory(options.DataDir);
paths.CreatePrivateDirectory(Path.Combine(options.DataDir, "logs"));
var log = new RunnerLog(Path.Combine(options.DataDir, "logs"));
log.Info($"RPA runner {version} starting (data dir {options.DataDir}, policy {options.PolicyPath})");

if (File.Exists(options.PolicyPath))
{
    var problems = PolicyFileCheck.Problems(options.PolicyPath);
    foreach (var problem in problems) log.Error($"policy file: {problem}");
    if (problems.Count > 0)
    {
        log.Error("cannot start: the policy file and its folder must be changeable by administrators only");
        return 1;
    }
}

using var desktop = new WindowsDesktop();
RunnerHost host;
try
{
    host = await RunnerHost.StartAsync(options, desktop, new WindowsProcessHost(), new DpapiKeyProtector(), TimeProvider.System, log, version, paths);
}
catch (Exception e) when (e is RunnerPolicy.InvalidPolicyException or InvalidOperationException or IOException or UnauthorizedAccessException)
{
    log.Error($"cannot start: {e.Message}");
    return 1;
}

var session = desktop.GetSessionState();
if (!session.Usable) log.Warn($"the desktop is not usable now ({session.Problem()}); runs fail with desktop_unavailable until it is");
var line = $"RPA runner listening on wss://{options.Bind}:{host.Port}/rpa/v1, fingerprint {host.Fingerprint}";
log.Info(line);

var stop = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    stop.TrySetResult();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.TrySetResult();
await stop.Task;
log.Info("stopping");
await host.DisposeAsync();
return 0;
