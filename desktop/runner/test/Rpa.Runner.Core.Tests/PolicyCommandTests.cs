using System.Security.Cryptography;
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

    private static readonly string Starter = """{ "allowedApps": [], "maxFileBytes": 20971520 }""";
    private static readonly string Change = $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}} }] }""";

    private sealed class FakeFiles : IPolicyFiles
    {
        public Dictionary<string, string> Text { get; } = [];
        public Dictionary<string, byte[]> Bytes { get; } = [];
        public List<(string Path, string Json, DateTimeOffset Now)> Writes { get; } = [];
        public List<string> BytesRead { get; } = [];

        public string? Read(string path) => Text.GetValueOrDefault(path);

        public void WriteWithBackup(string path, string json, DateTimeOffset now)
        {
            Writes.Add((path, json, now));
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
        Assert.Equal($"Allow app ErpDemo.exe at {ErpPath}\n{Prompt}{Updated}\n", tool.Output);
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
        Assert.Equal($"Allow app ErpDemo.exe at {ErpPath}\n{Prompt}", tool.Output);
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
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes"));
        Assert.Equal($"Allow app ErpDemo.exe at {ErpPath}\n{Updated}\n", tool.Output);
        var write = Assert.Single(tool.Files.Writes);
        Assert.Equal(Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json"), write.Path);
        Assert.Equal(1, tool.Restarts);
    }

    [Fact]
    public void Nothing_to_change_writes_nothing_and_does_not_restart()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("Nothing to change.\n", tool.Output);
        Assert.Single(tool.Files.Writes);
        Assert.Equal(1, tool.Restarts);
    }

    [Fact]
    public void Allow_app_builds_a_change_from_the_file_name_and_path_and_pin_hash_adds_the_file_s_SHA_256()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("y\n", "allow-app", ErpPath, "--policy", PolicyPath));
        Assert.Equal($"Allow app ErpDemo.exe at {ErpPath}\n{Prompt}{Updated}\n", tool.Output);
        var app = Assert.Single(RunnerPolicy.Parse(tool.Files.Writes[0].Json).AllowedApps);
        Assert.Equal(("ErpDemo.exe", ErpPath, null), (app.Exe, app.Path, app.Sha256));
        Assert.Empty(tool.Files.BytesRead);

        byte[] exe = [0x4d, 0x5a, 0x90, 0x00, 0x03];
        tool.Files.Bytes[ErpPath] = exe;
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"Update app ErpDemo.exe at {ErpPath}\n{Updated}\n", tool.Output);
        app = Assert.Single(RunnerPolicy.Parse(tool.Files.Writes[1].Json).AllowedApps);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(exe)), app.Sha256);
        Assert.Equal(2, tool.Restarts);
    }

    [Fact]
    public void Allow_app_says_when_a_new_app_is_pinned_and_refuses_a_file_it_cannot_read()
    {
        var tool = new Tool();
        tool.Files.Bytes[ErpPath] = [1, 2, 3];
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"Allow app ErpDemo.exe at {ErpPath} (SHA-256 pinned)\n{Updated}\n", tool.Output);

        var missing = Path.Combine(Root, "Missing", "Missing.exe");
        Assert.Equal(1, tool.Run("", "allow-app", missing, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Contains(missing, tool.Output);
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
    public void A_refused_change_exits_1_and_says_why()
    {
        var tool = new Tool();
        tool.Files.Text[ChangePath] = """{ "maxFileBytes": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Contains("maxFileBytes", tool.Output);
        Assert.DoesNotContain(Prompt, tool.Output);
        Assert.Empty(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);
    }

    [Fact]
    public void Apply_creates_the_policy_when_there_is_none()
    {
        var tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal(20971520, RunnerPolicy.Parse(Assert.Single(tool.Files.Writes).Json).MaxFileBytes);
    }

    [Fact]
    public void Show_prints_the_policy_file()
    {
        var tool = new Tool();
        Assert.Equal(0, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"Policy file: {PolicyPath}\n{Starter}\n", tool.Output);

        tool.Files.Text[PolicyPath] = """{ "allowedApp": [] }""";
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.StartsWith($"Policy file: {PolicyPath}\n{{ \"allowedApp\": [] }}\n{PolicyPath}: ", tool.Output);

        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"Policy file not found: {PolicyPath}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
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
        Assert.Equal(PolicyPath + ".20261109-140509.bak", PolicyCommand.BackupPath(PolicyPath, now));
        Assert.Equal("policy.json.20261109-140509.bak", Path.GetFileName(PolicyCommand.BackupPath(PolicyPath, now)));
    }
}
