using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Rpa.Runner.Core.Policy;

/// <summary>The files the policy tool touches (the real file system in RpaPolicy.exe, a fake in the tests).</summary>
public interface IPolicyFiles
{
    /// <summary>The file's text, or null when there is no such file.</summary>
    string? Read(string path);

    /// <summary>Replaces the policy file's text. An existing file is kept beside it as
    /// <see cref="PolicyCommand.BackupPath"/> names it.</summary>
    void WriteWithBackup(string path, string json, DateTimeOffset now);

    byte[] ReadAllBytes(string path);
}

/// <summary>
/// The policy tool's commands: <c>show</c>, <c>apply</c> and <c>allow-app</c>. A change is shown as plain lines and
/// written only after a yes (or with <c>--yes</c>). Exit codes: 0 applied or nothing to change, 1 refused or invalid,
/// 2 usage, 3 declined at the prompt.
/// </summary>
public static class PolicyCommand
{
    public const string Usage = """
        Usage: RpaPolicy show [--policy <path>]
               RpaPolicy apply <change.json> [--yes] [--policy <path>]
               RpaPolicy allow-app <path-to-exe> [--pin-hash] [--yes] [--policy <path>]
          show          Print the policy file
          apply         Add what a change file lists to the policy
          allow-app     Add an application to the policy's allowedApps
          --pin-hash    Also pin the application file's SHA-256
          --yes         Do not ask before writing
          --policy      The policy file (default %ProgramData%\RPA Runner\policy.json)
        """;

    private sealed record Arguments(string Command, string? Target, string PolicyPath, bool Yes, bool PinHash);

    /// <summary><c>policy.json.&lt;yyyyMMdd-HHmmss&gt;.bak</c> beside the policy file.</summary>
    public static string BackupPath(string policyPath, DateTimeOffset now) =>
        $"{policyPath}.{now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture)}.bak";

    public static int Run(string[] args, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner)
    {
        if (args is ["--help"] or ["-h"] or ["/?"])
        {
            output.WriteLine(Usage);
            return 0;
        }
        if (Parse(args) is not { } arguments)
        {
            output.WriteLine(Usage);
            return 2;
        }
        try
        {
            return arguments.Command switch
            {
                "show" => Show(arguments.PolicyPath, output, files),
                "apply" => files.Read(arguments.Target!) is { } change
                    ? Change(change, arguments, input, output, files, restartRunner)
                    : Fail(output, $"Change file not found: {arguments.Target}"),
                _ => Change(AllowApp(arguments, files), arguments, input, output, files, restartRunner),
            };
        }
        catch (Exception e) when (e is RunnerPolicy.InvalidPolicyException or IOException or UnauthorizedAccessException)
        {
            return Fail(output, e.Message);
        }
    }

    /// <summary>The command, its one file argument (none for show) and its options, or null for anything else.</summary>
    private static Arguments? Parse(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("show" or "apply" or "allow-app")) return null;
        var command = args[0];
        string? target = null, policy = null;
        bool yes = false, pinHash = false;
        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--policy" when i + 1 < args.Length: policy = args[++i]; break;
                case "--yes" when command != "show": yes = true; break;
                case "--pin-hash" when command == "allow-app": pinHash = true; break;
                case var a when !a.StartsWith("--", StringComparison.Ordinal) && target is null && command != "show": target = a; break;
                default: return null;
            }
        }
        if (target is null && command != "show") return null;
        return new Arguments(command, target, policy ?? Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json"), yes, pinHash);
    }

    private static int Fail(TextWriter output, string message)
    {
        output.WriteLine(message);
        return 1;
    }

    private static int Show(string policyPath, TextWriter output, IPolicyFiles files)
    {
        if (files.Read(policyPath) is not { } text) return Fail(output, $"Policy file not found: {policyPath}");
        output.WriteLine($"Policy file: {policyPath}");
        output.WriteLine(text.TrimEnd());
        RunnerPolicy.Parse(text, policyPath);
        return 0;
    }

    /// <summary>The change that allows one application: its file name, its full path and, when asked, its hash.</summary>
    private static string AllowApp(Arguments arguments, IPolicyFiles files)
    {
        var path = Path.GetFullPath(arguments.Target!);
        var app = new Dictionary<string, string> { ["exe"] = Path.GetFileName(path), ["path"] = path };
        if (arguments.PinHash) app["sha256"] = Convert.ToHexString(SHA256.HashData(files.ReadAllBytes(path)));
        return JsonSerializer.Serialize(new Dictionary<string, object> { ["allowedApps"] = new[] { app } });
    }

    private static int Change(string change, Arguments arguments, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner)
    {
        var result = PolicyChange.Apply(files.Read(arguments.PolicyPath) ?? "", change);
        if (result.Summary.Count == 0)
        {
            output.WriteLine("Nothing to change.");
            return 0;
        }
        foreach (var line in result.Summary) output.WriteLine(line);
        if (!arguments.Yes)
        {
            output.Write("Apply these changes? [y/N] ");
            output.Flush();
            if (input.ReadLine()?.Trim().ToLowerInvariant() is not ("y" or "yes")) return 3;
        }
        files.WriteWithBackup(arguments.PolicyPath, result.Json, DateTimeOffset.Now);
        restartRunner();
        output.WriteLine("Policy updated. The runner restarts within 10 seconds and uses the new policy.");
        return 0;
    }
}
