using System.Security.Cryptography;
using System.Text;
using Rpa.Runner.Core.Policy;

namespace Rpa.Runner.Core.Tests;

public class PolicyCommandTests
{
    private const string Updated = "Policy updated. The runner restarts within 10 seconds and uses the new policy.";
    private const string Prompt = "Apply these changes? [y/N] ";
    private const string Closing = "Press Enter to close.";

    // The usage as printed: line by line, whatever line ends the source file was checked out with.
    private static readonly string UsageText = PolicyCommand.Usage.ReplaceLineEndings("\n") + "\n";

    private static readonly string Root = OperatingSystem.IsWindows() ? @"C:\Program Files" : "/opt";
    private static readonly string ErpPath = Path.Combine(Root, "ERP Demo", "ErpDemo.exe");
    private static readonly string PolicyPath = Path.Combine(Root, "RPA Runner", "policy.json");
    private static readonly string ChangePath = Path.Combine(Root, "changes", "change.json");
    private static string J(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    /// <summary>A plain ASCII value as the summary shows it: a JSON string literal.</summary>
    private static string L(string value) => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private static readonly string Starter = """{ "allowedApps": [], "maxFileBytes": 20971520 }""";
    private static readonly string Change = $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}} }] }""";
    private static readonly string AllowErp = $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}";
    private static readonly string OneApp = "This change: 1 app(s) allowed or updated, 0 helper process pattern(s), 0 write control(s), 0 gated key(s).";

    private static string Changing(int apps = 0, int helpers = 0) =>
        $"Changing the policy at {PolicyPath} ({apps} app(s), {helpers} helper process pattern(s) today).";

    private sealed class FakeFiles : IPolicyFiles
    {
        public Dictionary<string, string> Text { get; } = [];
        public Dictionary<string, byte[]> Bytes { get; } = [];
        public List<(string Path, string Json, DateTimeOffset Now)> Writes { get; } = [];
        public List<string> Reads { get; } = [];
        public List<string> BytesRead { get; } = [];

        /// <summary>What the runner's start check says about a file; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> Untrusted { get; } = [];

        /// <summary>What the start check says about a file once the tool has written it.</summary>
        public string[] UntrustedAfterWrite { get; set; } = [];

        public List<string> Checked { get; } = [];

        /// <summary>When set, writing the policy fails with it.</summary>
        public Exception? WriteFailure { get; set; }

        public IReadOnlyList<string> Problems(string path)
        {
            Checked.Add(path);
            return Untrusted.GetValueOrDefault(path, []);
        }

        public string? Read(string path)
        {
            Reads.Add(path);
            return Text.GetValueOrDefault(path);
        }

        /// <summary>A size to report in place of the text's own (a file that grows after its size was read).</summary>
        public Dictionary<string, long> Sizes { get; } = [];

        public long? Length(string path) =>
            Sizes.TryGetValue(path, out var size) ? size : Text.TryGetValue(path, out var text) ? Encoding.UTF8.GetByteCount(text) : null;

        /// <summary>As RpaPolicy.exe does: the old text goes to the name PolicyCommand.BackupPath gives.</summary>
        public void WriteWithBackup(string path, string json, DateTimeOffset now)
        {
            if (WriteFailure is not null) throw WriteFailure;
            Writes.Add((path, json, now));
            if (Text.TryGetValue(path, out var old)) Text[PolicyCommand.BackupPath(path, now, Text.ContainsKey)] = old;
            Text[path] = json;
            if (UntrustedAfterWrite.Length > 0) Untrusted[path] = UntrustedAfterWrite;
        }

        public byte[] ReadAllBytes(string path)
        {
            BytesRead.Add(path);
            return Bytes.TryGetValue(path, out var bytes) ? bytes : throw new FileNotFoundException($"Could not find file '{path}'.");
        }
    }

    private sealed class Tool
    {
        public FakeFiles Files { get; } = new();
        public int Restarts { get; private set; }
        public string Output { get; private set; } = "";

        /// <summary>False: the tool owns its console (started through the administrator prompt by a program that is
        /// not elevated).</summary>
        public bool ExistingConsole { get; set; } = true;

        /// <summary>When set, ending the runner fails with it.</summary>
        public Exception? RestartFailure { get; set; }

        /// <summary>What was typed and not read.</summary>
        public string Unread { get; private set; } = "";

        public Tool()
        {
            Files.Text[PolicyPath] = Starter;
            Files.Text[ChangePath] = Change;
        }

        public int Run(string typed, params string[] args)
        {
            var output = new StringWriter { NewLine = "\n" };
            var input = new StringReader(typed);
            var code = PolicyCommand.Run(args, input, output, Files, () => { Restarts++; if (RestartFailure is not null) throw RestartFailure; }, ExistingConsole);
            Output = output.ToString();
            Unread = input.ReadToEnd();
            return code;
        }
    }

    [Fact]
    public void Apply_prints_the_summary_and_asks_and_y_writes_with_a_backup_and_restarts_the_runner()
    {
        var tool = new Tool();
        var before = DateTimeOffset.Now;
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{Updated}\n", tool.Output);
        var write = Assert.Single(tool.Files.Writes);
        Assert.Equal(PolicyPath, write.Path);
        Assert.InRange(write.Now, before, DateTimeOffset.Now);
        Assert.Equal(ErpPath, Assert.Single(RunnerPolicy.Parse(write.Json).AllowedApps).Path);
        Assert.Equal(1, tool.Restarts);
    }

    [Theory]
    [InlineData("n\n")]
    [InlineData("\n")]
    [InlineData("")]
    [InlineData("maybe\n")]
    public void N_writes_nothing(string typed)
    {
        var tool = new Tool();
        Assert.Equal(3, tool.Run(typed, "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}", tool.Output);
        Assert.Empty(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);
    }

    [Theory]
    [InlineData("Y\n")]
    [InlineData(" yes \n")]
    public void Y_in_other_spellings_applies(string typed)
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run(typed, "apply", ChangePath, "--policy", PolicyPath));
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void Yes_option_does_not_ask_and_the_default_policy_file_is_the_runner_s()
    {
        var tool = new Tool();
        var policy = Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes"));
        Assert.Equal($"Creating a new policy at {policy}.\n{AllowErp}\n{OneApp}\n{Updated}\n", tool.Output);
        Assert.Equal(policy, Assert.Single(tool.Files.Writes).Path);
        Assert.Equal(1, tool.Restarts);
    }

    [Fact]
    public void The_first_line_says_which_policy_changes_and_what_it_holds_today()
    {
        var tool = new Tool();
        tool.Files.Text[PolicyPath] = $$"""
            { "allowedApps": [{ "exe": "Other.exe", "path": {{J(Path.Combine(Root, "Other", "Other.exe"))}} }, { "exe": "Third.exe", "path": {{J(Path.Combine(Root, "Third", "Third.exe"))}} }],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(Path.Combine(Root, "EdgeWebView", "*", "msedgewebview2.exe"))}} }] }
            """;
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing(apps: 2, helpers: 1)}\n{AllowErp}\n{OneApp}\n{Prompt}", tool.Output);
    }

    [Fact]
    public void Nothing_to_change_writes_nothing_and_does_not_restart()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing(apps: 1)}\nNothing to change.\n", tool.Output);
        Assert.Single(tool.Files.Writes);
        Assert.Equal(1, tool.Restarts);
    }

    [Fact]
    public void Allow_app_builds_a_change_from_the_file_name_and_path_and_pin_hash_adds_the_file_s_SHA_256()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("y\n", "allow-app", ErpPath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{Updated}\n", tool.Output);
        var app = Assert.Single(RunnerPolicy.Parse(tool.Files.Writes[0].Json).AllowedApps);
        Assert.Equal(("ErpDemo.exe", ErpPath, null), (app.Exe, app.Path, app.Sha256));
        Assert.Empty(tool.Files.BytesRead);

        byte[] exe = [0x4d, 0x5a, 0x90, 0x00, 0x03];
        var hash = Convert.ToHexString(SHA256.HashData(exe));
        tool.Files.Bytes[ErpPath] = exe;
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"{Changing(apps: 1)}\nUpdate app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {hash})\n{OneApp}\n{Updated}\n", tool.Output);
        app = Assert.Single(RunnerPolicy.Parse(tool.Files.Writes[1].Json).AllowedApps);
        Assert.Equal(hash, app.Sha256);
        Assert.Equal(2, tool.Restarts);
    }

    [Fact]
    public void Allow_app_on_an_existing_app_keeps_its_argument_lists_and_its_pin()
    {
        var tool = new Tool();
        byte[] v1 = [1, 2, 3], v2 = [4, 5, 6];
        var pinned = Convert.ToHexString(SHA256.HashData(v1));
        var changed = Convert.ToHexString(SHA256.HashData(v2));
        tool.Files.Text[PolicyPath] = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "sha256": "{{pinned}}",
                                "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]], "allowUserWritable": true }] }
            """;

        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--yes", "--policy", PolicyPath));
        Assert.Equal($"{Changing(apps: 1)}\nNothing to change.\n", tool.Output);
        Assert.Empty(tool.Files.Writes);

        tool.Files.Bytes[ErpPath] = v2;
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal(
            $"{Changing(apps: 1)}\nUpdate app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pin changed from {pinned} to {changed})\n" +
            $"WARNING: {L(ErpPath)} can be changed by the runner's own user\n{OneApp}\n{Updated}\n",
            tool.Output);
        var app = Assert.Single(RunnerPolicy.Parse(Assert.Single(tool.Files.Writes).Json).AllowedApps);
        Assert.Equal(changed, app.Sha256);
        Assert.Equal(["--ui v1", "--ui v2"], app.AllowedArgs.Select(list => string.Join(' ', list)));
        Assert.True(app.AllowUserWritable);
    }

    [Fact]
    public void Allow_app_says_the_hash_of_a_new_app_and_refuses_a_file_it_cannot_read()
    {
        var tool = new Tool();
        tool.Files.Bytes[ErpPath] = [1, 2, 3];
        var hash = Convert.ToHexString(SHA256.HashData(tool.Files.Bytes[ErpPath]));
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp} (SHA-256 pinned {hash})\n{OneApp}\n{Updated}\n", tool.Output);

        var missing = Path.Combine(Root, "Missing", "Missing.exe");
        Assert.Equal(1, tool.Run("", "allow-app", missing, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"Could not find file '{missing}'.\n", tool.Output);
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void A_missing_change_file_exits_1_and_names_it()
    {
        var tool = new Tool();
        var missing = Path.Combine(Root, "changes", "missing.json");
        Assert.Equal(1, tool.Run("y\n", "apply", missing, "--policy", PolicyPath));
        Assert.Equal($"Change file not found: {missing}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void A_change_file_larger_than_256_KiB_is_refused_before_it_is_read()
    {
        var tool = new Tool();
        tool.Files.Text[ChangePath] = Change + new string(' ', 256 * 1024 - Change.Length);
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Contains(ChangePath, tool.Files.Reads);

        tool.Files.Reads.Clear();
        tool.Files.Text[ChangePath] += " ";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("the change file is larger than 256 KiB\n", tool.Output);
        Assert.DoesNotContain(ChangePath, tool.Files.Reads);

        // A file that grew between the size check and the read is refused as well.
        tool.Files.Sizes[ChangePath] = 100;
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("the change file is larger than 256 KiB\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void A_summary_longer_than_8000_characters_is_refused_before_it_is_printed()
    {
        const string refusal = "the summary of this change would be longer than 8000 characters; split it into smaller changes";
        // 33 entries, well inside every other limit. The last id sets the summary's length to the character.
        static string Controls(int lastId) => "{ \"writeControls\": [" +
            string.Join(", ", Enumerable.Range(0, 32).Select(i => $"{{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"{i:D2}{new string('x', 200)}\" }}")) +
            $", {{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"z{new string('x', lastId)}\" }}] }}";

        // What counts: every line up to the prompt (the first line, the summary, the count line), each with one
        // character for its line break, as this test's writer ends lines.
        var tool = new Tool();
        tool.Files.Text[ChangePath] = Controls(0);
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        var room = 8000 - (tool.Output.Length - Prompt.Length);
        Assert.InRange(room, 1, 250);

        tool.Files.Text[ChangePath] = Controls(room);
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(8000, tool.Output.Length - Prompt.Length);
        Assert.StartsWith($"{Changing()}\nAdd write control \"ErpDemo.exe\" / \"00xxx", tool.Output);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));

        foreach (var options in new string[][] { [], ["--yes"] })
        {
            tool = new Tool();
            tool.Files.Text[ChangePath] = Controls(room + 1);
            Assert.Equal(1, tool.Run("y\n", ["apply", ChangePath, "--policy", PolicyPath, .. options]));
            Assert.Equal($"{Changing()}\n{refusal}\n", tool.Output);
            Assert.Empty(tool.Files.Writes);
            Assert.Equal(0, tool.Restarts);
        }
    }

    [Fact]
    public void A_change_that_is_small_in_bytes_and_long_when_escaped_is_refused()
    {
        // One app with two argument lists of 20 arguments: under 3,000 bytes in the file. Each of its 2,360 delete
        // characters (one byte, not printable) is six characters in the summary.
        var lists = string.Join(", ", Enumerable.Range(0, 2).Select(i => "[" + string.Join(", ", Enumerable.Repeat($"\"{i}{new string('\u007f', 59)}\"", 20)) + "]"));
        var tool = new Tool();
        tool.Files.Text[ChangePath] = $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowUserWritable": true, "allowedArgs": [{{lists}}] }] }""";
        Assert.InRange(Encoding.UTF8.GetByteCount(tool.Files.Text[ChangePath]), 2400, 3000);
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\nthe summary of this change would be longer than 8000 characters; split it into smaller changes\n", tool.Output);
        Assert.Empty(tool.Files.Writes);

        // With one list of four such arguments the same app is shown, warning and all.
        tool.Files.Text[ChangePath] = $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowUserWritable": true, "allowedArgs": [[{{string.Join(", ", Enumerable.Repeat($"\"{new string('\u007f', 59)}\"", 4))}}]] }] }""";
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Contains($"\n{AllowErp}\nWARNING: {L(ErpPath)} can be changed by the runner's own user\n  with arguments: \"\\u007F", tool.Output);
    }

    [Fact]
    public void A_refused_change_exits_1_and_says_why()
    {
        var tool = new Tool();
        tool.Files.Text[ChangePath] = """{ "maxFileBytes": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\nthe change: maxFileBytes cannot be changed by a change (edit the policy file)\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);
    }

    [Fact]
    public void Apply_creates_the_policy_when_there_is_none()
    {
        var tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal($"Creating a new policy at {PolicyPath}.\n{AllowErp}\n{OneApp}\n{Updated}\n", tool.Output);
        Assert.Equal(20971520, RunnerPolicy.Parse(Assert.Single(tool.Files.Writes).Json).MaxFileBytes);
    }

    [Fact]
    public void An_existing_policy_file_the_runner_s_start_check_refuses_is_not_used()
    {
        // A user who is not an administrator may have planted it; merging it would give it an administrator's write.
        string[][] commands = [["apply", ChangePath, "--yes"], ["allow-app", ErpPath, "--yes"], ["show"]];
        foreach (var command in commands)
        {
            var tool = new Tool();
            tool.Files.Untrusted[PolicyPath] = [@"PC\bot owns the policy file", @"BUILTIN\Users can change or replace the policy file's folder"];
            Assert.Equal(1, tool.Run("y\n", [.. command, "--policy", PolicyPath]));
            Assert.Equal(
                @"the existing policy file cannot be trusted: PC\bot owns the policy file; BUILTIN\Users can change or replace the policy file's folder; " +
                "an administrator must check and replace it\n",
                tool.Output);
            Assert.Empty(tool.Files.Writes);
            Assert.Equal(0, tool.Restarts);
        }
    }

    [Fact]
    public void A_policy_the_start_check_refuses_after_the_write_is_reported_and_the_runner_is_left_running()
    {
        var tool = new Tool();
        tool.Files.UntrustedAfterWrite = [@"PC\bot can change or replace the policy file"];
        Assert.Equal(1, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal(
            $"{Changing()}\n{AllowErp}\n{OneApp}\n" +
            @"The policy file was written, but the runner will not start with it: PC\bot can change or replace the policy file. " +
            "The policy file and its folder must be changeable by administrators only.\n",
            tool.Output);
        Assert.Single(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);

        // A new policy is checked after the write too, and only then.
        tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal([PolicyPath], tool.Files.Checked);
        Assert.Equal(1, tool.Restarts);
    }

    [Fact]
    public void Yes_is_ignored_when_the_tool_owns_its_console()
    {
        // Whoever starts the tool chooses its arguments; the administrator who then approves the Windows prompt sees
        // only the program's name. So the change is still shown and asked about.
        var policy = Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
        var tool = new Tool { ExistingConsole = false };
        tool.Files.Text[policy] = Starter;
        string[][] commands = [["apply", ChangePath, "--yes"], ["allow-app", ErpPath, "--yes"]];
        var shown = "--yes is ignored: start RpaPolicy from an administrator console to use it\n" +
                    $"Changing the policy at {policy} (0 app(s), 0 helper process pattern(s) today).\n{AllowErp}\n{OneApp}\n{Prompt}";
        foreach (var command in commands)
        {
            Assert.Equal(3, tool.Run("", command));
            Assert.Equal($"{shown}{Closing}\n", tool.Output);
            Assert.Empty(tool.Files.Writes);
        }

        Assert.Equal(0, tool.Run("y\n\n", "apply", ChangePath, "--yes"));
        Assert.Equal($"{shown}{Updated}\n{Closing}\n", tool.Output);
        Assert.Equal(policy, Assert.Single(tool.Files.Writes).Path);
    }

    [Fact]
    public void A_tool_that_owns_its_console_waits_for_Enter_before_every_exit()
    {
        // Its window closes when it exits, so without the wait nothing it printed could be read.
        var policy = Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
        var cases = new (int Code, string Typed, string[] Args)[]
        {
            (2, "\nrest", []),
            (0, "\nrest", ["--help"]),
            (1, "\nrest", ["show", "--policy", PolicyPath]),
            (1, "\nrest", ["show"]),
            (1, "\nrest", ["apply", Path.Combine(Root, "changes", "missing.json")]),
            (3, "n\n\nrest", ["apply", ChangePath]),
            (0, "y\n\nrest", ["apply", ChangePath]),
            (0, "\nrest", ["apply", ChangePath]),
        };
        var tool = new Tool { ExistingConsole = false };
        foreach (var (code, typed, args) in cases)
        {
            Assert.Equal(code, tool.Run(typed, args));
            Assert.EndsWith($"\n{Closing}\n", "\n" + tool.Output.Replace(Prompt, Prompt + "\n"));
            Assert.Equal("rest", tool.Unread);
        }
        Assert.Equal(policy, Assert.Single(tool.Files.Writes).Path);

        // From a console that was already there, nothing is added and nothing more is read.
        tool = new Tool();
        Assert.Equal(2, tool.Run("\nrest"));
        Assert.DoesNotContain(Closing, tool.Output);
        Assert.Equal("\nrest", tool.Unread);
    }

    [Fact]
    public void A_failed_write_is_reported_and_the_runner_is_not_restarted()
    {
        Exception[] failures = [new IOException("the backup folder cannot be trusted: PC\\bot owns the backup folder"), new UnauthorizedAccessException("Access to the path is denied."), new InvalidOperationException("unexpected")];
        foreach (var failure in failures)
        {
            var tool = new Tool();
            tool.Files.WriteFailure = failure;
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal(
                $"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}Writing the policy failed: {failure.Message.TrimEnd('.')}. The runner keeps running with the policy it has.\n",
                tool.Output);
            Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
            Assert.Equal(0, tool.Restarts);
        }
    }

    [Fact]
    public void A_runner_that_cannot_be_restarted_is_reported_after_the_policy_is_written()
    {
        var tool = new Tool { RestartFailure = new System.ComponentModel.Win32Exception(5, "Access is denied.") };
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal(
            $"{Changing()}\n{AllowErp}\n{OneApp}\nPolicy updated, but the runner could not be restarted: Access is denied. Restart it by hand.\n",
            tool.Output);
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void An_unexpected_failure_prints_its_message_and_exits_1()
    {
        // A path with a null character makes the framework throw an ArgumentException; any exception ends like this.
        var tool = new Tool { ExistingConsole = false };
        Assert.Equal(1, tool.Run("\n", "allow-app", ErpPath + "\0"));
        Assert.DoesNotContain("   at ", tool.Output);
        Assert.DoesNotContain("Exception", tool.Output);
        Assert.EndsWith($"\n{Closing}\n", tool.Output);
        Assert.Equal(2, tool.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
    }

    [Fact]
    public void Null_entries_in_the_policy_file_are_refused_with_a_message()
    {
        var tool = new Tool();
        tool.Files.Text[PolicyPath] = """{ "allowedApps": [null] }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("the current policy: an entry in allowedApps must be an object\n", tool.Output);
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"Policy file: {PolicyPath}\n{{ \"allowedApps\": [null] }}\n{PolicyPath}: an entry in allowedApps must be an object\n", tool.Output);
    }

    [Fact]
    public void Policy_option_is_refused_when_the_tool_owns_its_console()
    {
        string[][] commands = [["apply", ChangePath, "--policy", PolicyPath], ["allow-app", ErpPath, "--policy", PolicyPath, "--yes"], ["show", "--policy", PolicyPath]];
        foreach (var command in commands)
        {
            var tool = new Tool { ExistingConsole = false };
            Assert.Equal(1, tool.Run("\n", command));
            Assert.Equal($"--policy needs an administrator console\n{Closing}\n", tool.Output);
            Assert.Empty(tool.Files.Reads);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Theory]
    [InlineData(@"\\server\share\change.json")]
    [InlineData("//server/share/change.json")]
    [InlineData(@"\\?\C:\changes\change.json")]
    [InlineData(@"\\.\pipe\change")]
    public void A_change_file_that_is_not_on_a_local_drive_is_refused(string path)
    {
        var tool = new Tool();
        tool.Files.Text[path] = Change;
        Assert.Equal(1, tool.Run("y\n", "apply", path, "--policy", PolicyPath));
        Assert.Equal("the change file must be on a local drive\n", tool.Output);
        Assert.Empty(tool.Files.Reads);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void Show_prints_the_policy_file()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"Policy file: {PolicyPath}\n{Starter}\n", tool.Output);

        tool.Files.Text[PolicyPath] = "{\r\n  \"allowedApp\": []\r\n}\r\n";
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.StartsWith($"Policy file: {PolicyPath}\n{{\n  \"allowedApp\": []\n}}\n{PolicyPath}: ", tool.Output);

        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"Policy file not found: {PolicyPath}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void Everything_printed_shows_control_and_format_characters_as_escapes()
    {
        // A refusal that echoes part of the change: a cursor command, a line break and a language tag (a format
        // character outside the basic plane, so two escapes). The emoji is neither, and stays.
        var tool = new Tool();
        tool.Files.Text[ChangePath] = """{ "bad\u001b[1A\nkey\udb40\udc01\ud83d\ude00\u202e": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\nthe change: unknown key \"bad\\u001B[1A\\u000Akey\\uDB40\\uDC01\U0001F600\\u202E\"\n", tool.Output);

        // The show output keeps the file's own lines and escapes what is inside them; so do a path and a parse error.
        var odd = Path.Combine(Root, "RPA\u0007 Runner", "policy.json");
        // The file holds a tab, a line separator inside a string and (as JSON's own escape) a cursor command.
        tool.Files.Text[odd] = "{\n\t\"gatedKeys\": [\"F1\\u001b[2J\u2028\"]\r\n}\n";
        Assert.Equal(1, tool.Run("", "show", "--policy", odd));
        var shown = odd.Replace("\u0007", "\\u0007");
        Assert.Equal(
            $"Policy file: {shown}\n{{\n\\u0009\"gatedKeys\": [\"F1\\u001b[2J\\u2028\"]\n}}\n{shown}: gatedKeys has an invalid key chord \"F1\\u001B[2J\\u2028\"\n",
            tool.Output);

        Assert.Equal(1, tool.Run("", "show", "--policy", odd + "\u200b"));
        Assert.Equal($"Policy file not found: {shown}\\u200B\n", tool.Output);
    }

    [Fact]
    public void Print_tests_by_rune()
    {
        var output = new StringWriter { NewLine = "\n" };
        PolicyCommand.Print(output, "a\u001bb\U000E0001c\U0001F600d\u202ee\u2028f\u2029g\th\r\ni\u00a0\u00e9~");
        Assert.Equal("a\\u001Bb\\uDB40\\uDC01c\U0001F600d\\u202Ee\\u2028f\\u2029g\\u0009h\\u000D\\u000Ai\u00a0\u00e9~\n", output.ToString());
    }

    [Fact]
    public void No_arguments_prints_usage()
    {
        var tool = new Tool();
        Assert.Equal(2, tool.Run(""));
        Assert.Equal(UsageText, tool.Output);
        foreach (var line in new[] { "RpaPolicy show [--policy <path>]", "RpaPolicy apply <change.json> [--yes] [--policy <path>]", "RpaPolicy allow-app <path-to-exe> [--pin-hash] [--yes] [--policy <path>]" })
            Assert.Contains(line, PolicyCommand.Usage);
    }

    [Fact]
    public void Arguments_a_command_does_not_take_print_usage()
    {
        string[][] invalid =
        [
            ["remove-app", ErpPath], ["apply"], ["apply", ChangePath, "extra.json"], ["apply", ChangePath, "--pin-hash"],
            ["apply", ChangePath, "--policy"], ["apply", ChangePath, "--force"], ["allow-app"], ["show", ChangePath], ["show", "--yes"],
        ];
        foreach (var args in invalid)
        {
            var tool = new Tool();
            Assert.Equal(2, tool.Run("y\n", args));
            Assert.Equal(UsageText, tool.Output);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void Help_prints_usage_and_exits_0()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("", "--help"));
        Assert.Equal(UsageText, tool.Output);
    }

    [Fact]
    public void The_backup_goes_to_the_policy_backups_folder_beside_the_policy_with_the_time_in_its_name()
    {
        var now = new DateTimeOffset(2026, 11, 9, 14, 5, 9, TimeSpan.FromHours(1));
        var folder = Path.Combine(Root, "RPA Runner", "policy-backups");
        Assert.Equal(folder, PolicyCommand.BackupFolder(PolicyPath));
        Assert.Equal(Path.Combine(folder, "policy.json.20261109-140509.bak"), PolicyCommand.BackupPath(PolicyPath, now, _ => false));
    }

    [Fact]
    public void A_backup_takes_a_name_that_no_file_or_folder_has()
    {
        var now = new DateTimeOffset(2026, 11, 9, 14, 5, 9, TimeSpan.FromHours(1));
        var stem = Path.Combine(Root, "RPA Runner", "policy-backups", "policy.json.20261109-140509");
        // The names that exist, whether as a file (an earlier backup) or as a folder (planted to block the name).
        var taken = new HashSet<string>();
        foreach (var expected in new[] { ".bak", "-2.bak", "-3.bak", "-4.bak" })
        {
            var backup = PolicyCommand.BackupPath(PolicyPath, now, taken.Contains);
            Assert.Equal(stem + expected, backup);
            taken.Add(backup);
        }
        // A gap is not reused past: the first free name wins, and another second starts again.
        taken.Remove(stem + "-2.bak");
        Assert.Equal(stem + "-2.bak", PolicyCommand.BackupPath(PolicyPath, now, taken.Contains));
        Assert.EndsWith("policy.json.20261109-140510.bak", PolicyCommand.BackupPath(PolicyPath, now.AddSeconds(1), taken.Contains));
    }
}
