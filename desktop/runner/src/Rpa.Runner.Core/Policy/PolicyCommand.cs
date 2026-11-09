using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Rpa.Runner.Core.Policy;

/// <summary>The files the policy tool touches (the real file system in RpaPolicy.exe, a fake in the tests).</summary>
public interface IPolicyFiles
{
    /// <summary>The file's text, or null when there is no such file.</summary>
    string? Read(string path);

    /// <summary>The file's size in bytes, or null when there is no such file.</summary>
    long? Length(string path);

    /// <summary>What the runner's own start check finds wrong with the policy file and its folder (someone other than
    /// an administrator owns them or can change them); empty when it would pass.</summary>
    IReadOnlyList<string> Problems(string path);

    /// <summary>Replaces the policy file's text. An existing file is kept under the name
    /// <see cref="PolicyCommand.BackupPath"/> gives.</summary>
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
    /// <summary>A change file larger than this is refused unread: its summary would not fit above the prompt.</summary>
    public const long MaxChangeFileBytes = 256 * 1024;

    /// <summary>
    /// The most the tool prints before it asks: the first line, the summary lines and the count line together, each
    /// with one character for its line break. A longer summary is refused (a value can be six times its length when
    /// it is shown as escapes, so the limits on a change alone do not keep its summary short).
    /// </summary>
    public const int MaxSummaryLength = 8000;

    public const string Usage = """
        Usage: RpaPolicy show [--policy <path>]
               RpaPolicy apply <change.json> [--yes] [--policy <path>]
               RpaPolicy allow-app <path-to-exe> [--pin-hash] [--yes] [--policy <path>]
          show          Print the policy file
          apply         Add what a change file lists to the policy
          allow-app     Add an application to the policy's allowedApps
          --pin-hash    Also pin the application file's SHA-256
          --yes         Do not ask before writing (only from an administrator console)
          --policy      The policy file (default %ProgramData%\RPA Runner\policy.json; only from an
                        administrator console)
        """;

    private sealed record Arguments(string Command, string? Target, string? Policy, bool Yes, bool PinHash)
    {
        public string PolicyPath => Policy ?? Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
    }

    /// <summary>The folder for backups, <c>policy-backups</c> beside the policy file. It is the tool's own, for
    /// administrators only: the policy's folder may let the runner's user create files.</summary>
    public static string BackupFolder(string policyPath) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(policyPath)) ?? "", "policy-backups");

    /// <summary>
    /// <c>policy.json.&lt;yyyyMMdd-HHmmss&gt;.bak</c> in the backup folder, or with <c>-2</c>, <c>-3</c> and so on
    /// before <c>.bak</c>: the first of these names that is not taken (by a file or by a folder).
    /// </summary>
    public static string BackupPath(string policyPath, DateTimeOffset now, Func<string, bool> taken)
    {
        var stem = Path.Combine(BackupFolder(policyPath), $"{Path.GetFileName(policyPath)}.{now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture)}");
        var backup = $"{stem}.bak";
        for (var n = 2; taken(backup); n++) backup = $"{stem}-{n}.bak";
        return backup;
    }

    /// <summary>
    /// Writes one line (or, for the prompt, its start). Everything the tool prints goes through here: control and
    /// format characters, which could move the cursor, break the line or reorder the text, are written as
    /// <c>\uXXXX</c> (tested by rune, so a character outside the basic plane is two escapes).
    /// </summary>
    public static void Print(TextWriter output, string line, bool endLine = true)
    {
        if (endLine) output.WriteLine(Visible(line));
        else output.Write(Visible(line));
    }

    private static string Visible(string text)
    {
        var visible = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                foreach (var unit in rune.ToString()) visible.Append(CultureInfo.InvariantCulture, $"\\u{(int)unit:X4}");
            }
            else visible.Append(rune.ToString());
        }
        return visible.ToString();
    }

    /// <summary>
    /// Runs one command. <paramref name="startedFromExistingConsole"/> is false when the tool owns its console: it was
    /// started through the Windows administrator prompt by a program that is not elevated, and that program chose the
    /// arguments, while the administrator saw only the tool's name. Then <c>--yes</c> is ignored and <c>--policy</c>
    /// is refused, so the change to the runner's own policy is still shown and asked about.
    /// </summary>
    public static int Run(string[] args, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner, bool startedFromExistingConsole)
    {
        int code;
        try
        {
            code = Command(args, input, output, files, restartRunner, startedFromExistingConsole);
        }
        catch (Exception e)
        {
            // Refusals and anything unforeseen end the same way: the message, no stack trace, exit 1.
            code = Fail(output, e.Message);
        }
        if (!startedFromExistingConsole)
        {
            // The tool's own window closes when it exits; without this nothing it printed could be read.
            Print(output, "Press Enter to close.");
            input.ReadLine();
        }
        return code;
    }

    private static int Command(string[] args, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner, bool startedFromExistingConsole)
    {
        if (args is ["--help"] or ["-h"] or ["/?"])
        {
            PrintUsage(output);
            return 0;
        }
        if (Parse(args) is not { } arguments)
        {
            PrintUsage(output);
            return 2;
        }
        if (!startedFromExistingConsole)
        {
            if (arguments.Policy is not null) return Fail(output, "--policy needs an administrator console");
            if (arguments.Yes)
            {
                Print(output, "--yes is ignored: start RpaPolicy from an administrator console to use it");
                arguments = arguments with { Yes = false };
            }
        }
        return arguments.Command switch
        {
            "show" => Show(arguments.PolicyPath, output, files),
            "apply" => Change(ChangeFile(arguments.Target!, files), arguments, input, output, files, restartRunner),
            _ => Change(AllowApp(arguments, files), arguments, input, output, files, restartRunner),
        };
    }

    private static void PrintUsage(TextWriter output)
    {
        foreach (var line in Usage.ReplaceLineEndings("\n").Split('\n')) Print(output, line);
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
        return new Arguments(command, target, policy, yes, pinHash);
    }

    private static int Fail(TextWriter output, string message)
    {
        Print(output, message);
        return 1;
    }

    private static int Show(string policyPath, TextWriter output, IPolicyFiles files)
    {
        if (ExistingPolicy(policyPath, files) is not { } text) return Fail(output, $"Policy file not found: {policyPath}");
        Print(output, $"Policy file: {policyPath}");
        // The file's own line breaks stay; anything else that is not plain text inside a line is shown as an escape.
        foreach (var line in text.TrimEnd('\r', '\n').Split('\n')) Print(output, line.TrimEnd('\r'));
        PolicyChange.Parse(text, policyPath);
        return 0;
    }

    /// <summary>
    /// The policy file's text, or null when there is none. A file that is there is used only when the runner's own
    /// start check passes it: a user who is not an administrator may be able to create the file where none exists, and
    /// the tool would otherwise merge that file and write it back as an administrator's.
    /// </summary>
    private static string? ExistingPolicy(string path, IPolicyFiles files)
    {
        if (files.Length(path) is null) return null;
        var problems = files.Problems(path);
        if (problems.Count > 0)
            throw new RunnerPolicy.InvalidPolicyException($"the existing policy file cannot be trusted: {string.Join("; ", problems)}; an administrator must check and replace it");
        return files.Read(path);
    }

    /// <summary>The change file's text, from a local drive only. The size is checked before the file is read.</summary>
    private static string ChangeFile(string path, IPolicyFiles files)
    {
        if (RunnerPolicy.IsUncOrDevice(path) || RunnerPolicy.IsUncOrDevice(Path.GetFullPath(path)))
            throw new RunnerPolicy.InvalidPolicyException("the change file must be on a local drive");
        if (files.Length(path) is not { } length) throw new FileNotFoundException($"Change file not found: {path}");
        if (length > MaxChangeFileBytes) throw new RunnerPolicy.InvalidPolicyException("the change file is larger than 256 KiB");
        var text = files.Read(path) ?? throw new FileNotFoundException($"Change file not found: {path}");
        // The file may have grown since its size was read; text never has more characters than the file has bytes.
        if (text.Length > MaxChangeFileBytes) throw new RunnerPolicy.InvalidPolicyException("the change file is larger than 256 KiB");
        return text;
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
        var current = ExistingPolicy(arguments.PolicyPath, files);
        var first = $"Creating a new policy at {arguments.PolicyPath}.";
        if (current is not null)
        {
            var today = PolicyChange.Parse(current, "the current policy");
            first = $"Changing the policy at {arguments.PolicyPath} ({today.AllowedApps.Count} app(s), {today.HelperProcesses.Count} helper process pattern(s) today).";
        }
        Print(output, first);

        var result = PolicyChange.Apply(current ?? "", change);
        if (result.Summary.Count == 0)
        {
            Print(output, "Nothing to change.");
            return 0;
        }
        if (result.Summary.Prepend(first).Sum(line => Visible(line).Length + 1) > MaxSummaryLength)
            return Fail(output, $"the summary of this change would be longer than {MaxSummaryLength} characters; split it into smaller changes");
        foreach (var line in result.Summary) Print(output, line);
        if (!arguments.Yes)
        {
            Print(output, "Apply these changes? [y/N] ", endLine: false);
            output.Flush();
            if (input.ReadLine()?.Trim().ToLowerInvariant() is not ("y" or "yes")) return 3;
        }
        try
        {
            files.WriteWithBackup(arguments.PolicyPath, result.Json, DateTimeOffset.Now);
        }
        catch (Exception e)
        {
            return Fail(output, $"Writing the policy failed: {e.Message.TrimEnd('.')}. The runner keeps running with the policy it has.");
        }
        var problems = files.Problems(arguments.PolicyPath);
        if (problems.Count > 0)
        {
            return Fail(output, $"The policy file was written, but the runner will not start with it: {string.Join("; ", problems)}. " +
                                "The policy file and its folder must be changeable by administrators only.");
        }
        try
        {
            restartRunner();
        }
        catch (Exception e)
        {
            Print(output, $"Policy updated, but the runner could not be restarted: {e.Message.TrimEnd('.')}. Restart it by hand.");
            return 0;
        }
        Print(output, "Policy updated. The runner restarts within 10 seconds and uses the new policy.");
        return 0;
    }
}
