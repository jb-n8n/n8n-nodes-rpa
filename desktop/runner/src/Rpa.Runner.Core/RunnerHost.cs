using System.Net;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;
using Rpa.Runner.Core.Server;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core;

/// <summary>Runner settings from the command line and the environment (command line wins).</summary>
public sealed record RunnerOptions
{
    public const int DefaultPort = 8765;
    public const int MinTokenLength = 16;

    public int Port { get; init; } = DefaultPort;
    public IPAddress Bind { get; init; } = IPAddress.Any;
    public required string Token { get; init; }
    public required string DataDir { get; init; }
    public required string PolicyPath { get; init; }

    public static string DefaultDataDir() => OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RPA Runner")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rpa-runner");

    public const string Usage = """
        Usage: RpaRunner [options]
          --port <n>            Port to listen on (env RPA_RUNNER_PORT, default 8765)
          --bind <address>      Address to listen on (env RPA_RUNNER_BIND, default 0.0.0.0)
          --token-file <path>   File holding the bearer token (env RPA_RUNNER_TOKEN_FILE)
                                or set the token itself in env RPA_RUNNER_TOKEN (at least 16 characters)
          --data-dir <path>     Certificate, logs and export directories (env RPA_RUNNER_DATA_DIR,
                                default %ProgramData%\RPA Runner)
          --policy <path>       Policy file (env RPA_RUNNER_POLICY, default <data dir>\policy.json)
        """;

    /// <summary>Thrown for settings the runner refuses to start with; the message never contains the token.</summary>
    public sealed class InvalidOptionsException(string message) : Exception(message);

    public static RunnerOptions Parse(string[] args, Func<string, string?> env)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a is "--token")
                throw new InvalidOptionsException("--token is not accepted (other users can read command lines); use RPA_RUNNER_TOKEN or --token-file");
            if (a is not ("--port" or "--bind" or "--token-file" or "--data-dir" or "--policy"))
                throw new InvalidOptionsException($"unknown option {a}");
            if (i + 1 >= args.Length) throw new InvalidOptionsException($"{a} needs a value");
            map[a] = args[++i];
        }
        string? Get(string flag, string name) => map.TryGetValue(flag, out var v) ? v : env(name);

        var port = DefaultPort;
        var portText = Get("--port", "RPA_RUNNER_PORT");
        if (portText is not null && (!int.TryParse(portText, out port) || port is < 0 or > 65535))
            throw new InvalidOptionsException("port must be a number from 0 to 65535");

        var bind = IPAddress.Any;
        var bindText = Get("--bind", "RPA_RUNNER_BIND");
        if (bindText is not null && !IPAddress.TryParse(bindText, out bind!))
            throw new InvalidOptionsException("bind must be an IP address");

        string? token;
        var tokenFile = Get("--token-file", "RPA_RUNNER_TOKEN_FILE");
        if (tokenFile is not null)
        {
            if (!File.Exists(tokenFile)) throw new InvalidOptionsException("the token file does not exist");
            token = File.ReadAllText(tokenFile).Trim();
        }
        else token = env("RPA_RUNNER_TOKEN")?.Trim();
        if (string.IsNullOrEmpty(token)) throw new InvalidOptionsException("no token: set RPA_RUNNER_TOKEN or --token-file");
        if (token.Length < MinTokenLength) throw new InvalidOptionsException($"the token must be at least {MinTokenLength} characters");
        if (token.Any(char.IsWhiteSpace) || token.Any(char.IsControl)) throw new InvalidOptionsException("the token must not contain spaces or control characters");

        var dataDir = Path.GetFullPath(Get("--data-dir", "RPA_RUNNER_DATA_DIR") ?? DefaultDataDir());
        var policy = Path.GetFullPath(Get("--policy", "RPA_RUNNER_POLICY") ?? Path.Combine(dataDir, "policy.json"));
        return new RunnerOptions { Port = port, Bind = bind, Token = token, DataDir = dataDir, PolicyPath = policy };
    }
}

/// <summary>Wires the runner: policy, certificate, run manager, service, dispatcher and server.</summary>
public sealed class RunnerHost : IAsyncDisposable
{
    private readonly RunnerServer _server;

    private RunnerHost(RunnerServer server, RunManager runs, string fingerprint, string exportRoot)
    {
        _server = server;
        Runs = runs;
        Fingerprint = fingerprint;
        ExportRoot = exportRoot;
    }

    public RunManager Runs { get; }
    public string Fingerprint { get; }
    public string ExportRoot { get; }
    public int Port => _server.Port;

    public static async Task<RunnerHost> StartAsync(RunnerOptions options, IDesktop desktop, IProcessHost processes,
        IKeyProtector protector, TimeProvider time, RunnerLog log, string version)
    {
        var policy = RunnerPolicy.Load(options.PolicyPath);
        log.Info($"policy loaded: {policy.AllowedApps.Count} allowed app(s), {policy.WriteControls.Count} write control(s), " +
                 $"{policy.GatedKeys.Count} gated key(s), maxFileBytes={policy.MaxFileBytes}");
        var cert = CertificateStore.LoadOrCreate(options.DataDir, protector, log);
        var fingerprint = CertificateStore.Fingerprint(cert);
        var exportRoot = Path.Combine(options.DataDir, "exports");
        Directory.CreateDirectory(exportRoot);
        var runs = new RunManager(exportRoot, processes, time, log);
        runs.SweepStaleExportDirs();
        var service = new RunnerService(desktop, processes, policy, runs, time, log, version);
        var dispatcher = new RpcDispatcher(service, log);
        var server = RunnerServer.Create(options.Bind, options.Port, cert, options.Token, dispatcher, log);
        await server.StartAsync();
        return new RunnerHost(server, runs, fingerprint, exportRoot);
    }

    public async ValueTask DisposeAsync()
    {
        await _server.DisposeAsync();
        Runs.Dispose();
    }
}
