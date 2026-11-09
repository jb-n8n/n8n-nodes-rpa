using System.Security.Cryptography;
using System.Text;
using Rpa.Runner.Core.Policy;

namespace Rpa.Runner.Core.Tests;

public class PolicyCommandTests
{
    private const string Updated = "Policy updated. The runner restarts within 10 seconds and uses the new policy.";
    private const string Prompt = "Apply these changes? [y/N] ";

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

        public string? Read(string path)
        {
            Reads.Add(path);
            return Text.GetValueOrDefault(path);
        }

        public long? Length(string path) => Text.TryGetValue(path, out var text) ? Encoding.UTF8.GetByteCount(text) : null;

        /// <summary>As RpaPolicy.exe does: the old text goes to the name PolicyCommand.BackupPath gives.</summary>
        public void WriteWithBackup(string path, string json, DateTimeOffset now)
        {
            Writes.Add((path, json, now));
            if (Text.TryGetValue(path, out var old)) Text[PolicyCommand.BackupPath(path, now, Text.ContainsKey)] = old;
            Text[path] = json;
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

        public Tool()
        {
            Files.Text[PolicyPath] = Starter;
            Files.Text[ChangePath] = Change;
        }

        public int Run(string typed, params string[] args)
        {
            var output = new StringWriter { NewLine = "\n" };
            var code = PolicyCommand.Run(args, new StringReader(typed), output, Files, () => Restarts++);
            Output = output.ToString();
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
        Assert.Empty(tool.Files.Writes);
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
        tool.Files.Text[odd] = "{\n\t\"gatedKeys\": [\"F1\u001b[2J\"]\r\n}\u2028";
        Assert.Equal(1, tool.Run("", "show", "--policy", odd));
        var shown = odd.Replace("\u0007", "\\u0007");
        Assert.Equal(
            $"Policy file: {shown}\n{{\n\\u0009\"gatedKeys\": [\"F1\\u001B[2J\"]\n}}\\u2028\n{shown}: gatedKeys has an invalid key chord \"F1\\u001B[2J\"\n",
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
        Assert.Equal(PolicyCommand.Usage + "\n", tool.Output);
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
            Assert.Equal(PolicyCommand.Usage + "\n", tool.Output);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void Help_prints_usage_and_exits_0()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("", "--help"));
        Assert.Equal(PolicyCommand.Usage + "\n", tool.Output);
    }

    [Fact]
    public void The_backup_sits_beside_the_policy_with_the_time_in_its_name()
    {
        var now = new DateTimeOffset(2026, 11, 9, 14, 5, 9, TimeSpan.FromHours(1));
        var backup = PolicyCommand.BackupPath(PolicyPath, now, _ => false);
        Assert.Equal(PolicyPath + ".20261109-140509.bak", backup);
        Assert.Equal("policy.json.20261109-140509.bak", Path.GetFileName(backup));
    }

    [Fact]
    public void Writes_at_the_same_time_never_share_a_backup()
    {
        var now = new DateTimeOffset(2026, 11, 9, 14, 5, 9, TimeSpan.FromHours(1));
        var files = new FakeFiles();
        files.Text[PolicyPath] = "first";
        files.WriteWithBackup(PolicyPath, "second", now);
        files.WriteWithBackup(PolicyPath, "third", now);
        files.WriteWithBackup(PolicyPath, "fourth", now);
        files.WriteWithBackup(PolicyPath, "fifth", now.AddSeconds(1));
        Assert.Equal("fifth", files.Text[PolicyPath]);
        Assert.Equal("first", files.Text[PolicyPath + ".20261109-140509.bak"]);
        Assert.Equal("second", files.Text[PolicyPath + ".20261109-140509-2.bak"]);
        Assert.Equal("third", files.Text[PolicyPath + ".20261109-140509-3.bak"]);
        Assert.Equal("fourth", files.Text[PolicyPath + ".20261109-140510.bak"]);
        Assert.Equal(5, files.Text.Count);
    }
}
