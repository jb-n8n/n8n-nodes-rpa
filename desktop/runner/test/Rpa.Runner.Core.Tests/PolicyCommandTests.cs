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

    /// <summary>Summary lines as the tool prints them: a line longer than 76 characters in rows (PolicyChangeTests
    /// has the rows spelled out).</summary>
    private static string R(params string[] lines) => string.Join("\n", lines.SelectMany(PolicyChange.Rows));

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
        public HashSet<string> Folders { get; } = [];
        public List<(string Path, string Json, DateTimeOffset Now, bool Existed)> Writes { get; } = [];
        public List<string> Reads { get; } = [];

        /// <summary>The streams handed out for hashing, by path.</summary>
        public List<(string Path, OneWayStream Stream)> Opened { get; } = [];

        /// <summary>Every path whose kind was asked for.</summary>
        public List<string> Looked { get; } = [];

        /// <summary>What the runner's start check says about a file; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> Untrusted { get; } = [];

        /// <summary>What the start check says about a file once the tool has written it.</summary>
        public string[] UntrustedAfterWrite { get; set; } = [];

        public List<string> Checked { get; } = [];

        /// <summary>What is wrong with a backup folder; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> BackupProblems { get; } = [];

        /// <summary>When set, writing the policy fails with it.</summary>
        public Exception? WriteFailure { get; set; }

        /// <summary>Runs when the tool starts to write (something that happens while the administrator reads).</summary>
        public Action? BeforeWrite { get; set; }

        public IReadOnlyList<string> Problems(string path)
        {
            Checked.Add(path);
            return Untrusted.GetValueOrDefault(path, []);
        }

        public IReadOnlyList<string> BackupFolderProblems(string folder) => BackupProblems.GetValueOrDefault(folder, []);

        public PathKind Kind(string path)
        {
            Looked.Add(path);
            return Folders.Contains(path) ? PathKind.Folder : Text.ContainsKey(path) || Bytes.ContainsKey(path) ? PathKind.File : PathKind.None;
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

        /// <summary>
        /// As RpaPolicy.exe does: an existing policy's text goes to the name PolicyCommand.BackupPath gives; a new
        /// policy is written only when nothing has its name.
        /// </summary>
        public void WriteWithBackup(string path, string json, DateTimeOffset now, bool existed)
        {
            BeforeWrite?.Invoke();
            if (WriteFailure is not null) throw WriteFailure;
            if (!existed && Kind(path) != PathKind.None) throw new PolicyAppearedException();
            Writes.Add((path, json, now, existed));
            if (existed) Text[PolicyCommand.BackupPath(path, now, Text.ContainsKey)] = Text[path];
            Text[path] = json;
            if (UntrustedAfterWrite.Length > 0) Untrusted[path] = UntrustedAfterWrite;
        }

        public Stream OpenRead(string path)
        {
            if (!Bytes.TryGetValue(path, out var bytes)) throw new FileNotFoundException($"Could not find file '{path}'.");
            var stream = new OneWayStream(bytes);
            Opened.Add((path, stream));
            return stream;
        }
    }

    /// <summary>A file as a stream that can only be read forward, a piece at a time: no length, no position.</summary>
    private sealed class OneWayStream(byte[] bytes) : Stream
    {
        private int _at;

        public int LargestRead { get; private set; }
        public bool Closed { get; private set; }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = Math.Min(count, bytes.Length - _at);
            Array.Copy(bytes, _at, buffer, offset, read);
            _at += read;
            LargestRead = Math.Max(LargestRead, read);
            return read;
        }

        protected override void Dispose(bool disposing)
        {
            Closed = true;
            base.Dispose(disposing);
        }

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    // The consoles a test can put the tool in. Each entry of the list is one other process attached to the console:
    // true when it is elevated.
    private static readonly PolicyConsole Elevated = new([true], TakesKeys: false);
    private static readonly PolicyConsole OwnWindow = new([], TakesKeys: true);
    private static readonly PolicyConsole NoConsole = new(null, TakesKeys: false);

    /// <summary>Consoles in which whoever chose the arguments may not be an administrator.</summary>
    public static TheoryData<bool[]?, bool> OtherConsoles => new()
    {
        { [], true },             // alone in a window of its own
        { [], false },            // alone in a console nobody can type in (a scheduled task)
        { null, false },          // no console
        { [false], true },        // one other process, not elevated
        { [true, false], true },  // an elevated one and one that is not
        { [false, true, true], false },
    };

    private sealed class Tool
    {
        public FakeFiles Files { get; } = new();
        public int Restarts { get; private set; }
        public string Output { get; private set; } = "";

        /// <summary>The console the tool finds itself in; unless a test says otherwise, one it shares with one other
        /// process, which is elevated.</summary>
        public PolicyConsole Console { get; set; } = Elevated;

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
            var code = PolicyCommand.Run(args, input, output, Files, () => { Restarts++; if (RestartFailure is not null) throw RestartFailure; }, Console);
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
        Assert.Empty(tool.Files.Opened);

        byte[] exe = [0x4d, 0x5a, 0x90, 0x00, 0x03];
        var hash = Convert.ToHexString(SHA256.HashData(exe));
        tool.Files.Bytes[ErpPath] = exe;
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"{Changing(apps: 1)}\n{R($"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {hash})")}\n{OneApp}\n{Updated}\n", tool.Output);
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
            $"{Changing(apps: 1)}\n" +
            R($"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pin changed from {pinned} to {changed})", $"WARNING: {L(ErpPath)} can be changed by the runner's own user") +
            $"\n{OneApp}\n{Updated}\n",
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
        Assert.Equal($"{Changing()}\n{R($"{AllowErp} (SHA-256 pinned {hash})")}\n{OneApp}\n{Updated}\n", tool.Output);

        var missing = Path.Combine(Root, "Missing", "Missing.exe");
        Assert.Equal(1, tool.Run("", "allow-app", missing, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal($"Application file not found: {missing}\n", tool.Output);
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void Allow_app_pin_hash_hashes_the_file_from_a_stream()
    {
        // Three megabytes, read forward a piece at a time and never held whole.
        var exe = new byte[3 * 1024 * 1024];
        new Random(5).NextBytes(exe);
        var tool = new Tool();
        tool.Files.Bytes[ErpPath] = exe;
        Assert.Equal(0, tool.Run("", "allow-app", ErpPath, "--pin-hash", "--yes", "--policy", PolicyPath));
        Assert.Equal(Convert.ToHexString(SHA256.HashData(exe)), Assert.Single(RunnerPolicy.Parse(Assert.Single(tool.Files.Writes).Json).AllowedApps).Sha256);
        var (path, stream) = Assert.Single(tool.Files.Opened);
        Assert.Equal(ErpPath, path);
        Assert.InRange(stream.LargestRead, 1, 1024 * 1024);
        Assert.True(stream.Closed);
    }

    [Theory]
    [InlineData(@"\\server\share\App.exe")]
    [InlineData("//server/share/App.exe")]
    [InlineData(@"\\?\C:\Apps\App.exe")]
    [InlineData(@"\\.\PhysicalDrive0")]
    [InlineData(@"\\.\pipe\App.exe")]
    public void Allow_app_refuses_a_UNC_or_device_path_before_it_touches_it(string target)
    {
        // The text the parser has for such a path in a change file.
        var refusal = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => PolicyChange.Apply("", $$"""{ "allowedApps": [{ "exe": "App.exe", "path": {{J(target)}} }] }""")).Message;
        Assert.Equal("the change: allowedApps[].path must be an absolute local path (no UNC or device paths)", refusal);
        foreach (var options in new string[][] { ["--pin-hash"], [] })
        {
            var tool = new Tool();
            tool.Files.Bytes[target] = [1, 2, 3];
            Assert.Equal(1, tool.Run("y\n", ["allow-app", target, "--policy", PolicyPath, .. options]));
            Assert.Equal($"{refusal}\n", tool.Output);
            Assert.Empty(tool.Files.Opened);
            Assert.Empty(tool.Files.Looked);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void Allow_app_refuses_a_short_8_3_name_before_it_touches_it()
    {
        var target = Path.Combine(Root, "ERPDEM~1", "ErpDemo.exe");
        foreach (var options in new string[][] { ["--pin-hash"], [] })
        {
            var tool = new Tool();
            tool.Files.Bytes[target] = [1, 2, 3];
            Assert.Equal(1, tool.Run("y\n", ["allow-app", target, "--policy", PolicyPath, .. options]));
            Assert.Equal($"write the full path, not a short (8.3) name: {L(target)}\n", tool.Output);
            Assert.Empty(tool.Files.Opened);
            Assert.Empty(tool.Files.Looked);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void Allow_app_pin_hash_needs_a_regular_file()
    {
        var tool = new Tool();
        tool.Files.Folders.Add(ErpPath);
        Assert.Equal(1, tool.Run("y\n", "allow-app", ErpPath, "--pin-hash", "--policy", PolicyPath));
        Assert.Equal($"{ErpPath} is not a regular file\n", tool.Output);
        Assert.Empty(tool.Files.Opened);
        Assert.Empty(tool.Files.Writes);
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
        // 30 entries, well inside every other limit. The last two ids set the summary's length: a character more is
        // one more printed, or ten when it starts a new row (the line break and the eight spaces count).
        static string Controls(int nextToLast, int last) => "{ \"writeControls\": [" +
            string.Join(", ", Enumerable.Range(0, 28).Select(i => $"{{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"{i:D2}{new string('x', 200)}\" }}")) +
            $", {{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"y{new string('x', nextToLast)}\" }}" +
            $", {{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"z{new string('x', last)}\" }}] }}";

        // What counts is what is printed up to the prompt: the first line, every row of the summary with its eight
        // spaces, and the count line, each with one character for its line break (as this test's writer ends lines).
        var tool = new Tool();
        var lengths = new Dictionary<int, (int NextToLast, int Last)>();
        var refused = new List<(int NextToLast, int Last)>();
        for (var nextToLast = 0; nextToLast < 12; nextToLast++)
        {
            for (var last = 0; last <= 250; last++)
            {
                tool.Files.Text[ChangePath] = Controls(nextToLast, last);
                var code = tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath);
                if (code == 3) lengths[tool.Output.Length - Prompt.Length] = (nextToLast, last);
                else
                {
                    Assert.Equal(1, code);
                    Assert.Equal($"{Changing()}\n{refusal}\n", tool.Output);
                    refused.Add((nextToLast, last));
                }
            }
        }
        Assert.Equal(8000, lengths.Keys.Max());
        Assert.NotEmpty(refused);

        // Exactly 8,000 is shown, with its first line and its count line, and can be applied. One character more is not.
        var (a, b) = lengths[8000];
        tool.Files.Text[ChangePath] = Controls(a, b);
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.StartsWith($"{Changing()}\nAdd write control \"ErpDemo.exe\" / \"00xxx", tool.Output);
        Assert.EndsWith("\nThis change: 0 app(s) allowed or updated, 0 helper process pattern(s), 30 write control(s), 0 gated key(s).\n" + Prompt, tool.Output);
        Assert.Contains((a, b + 1), refused);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));

        foreach (var options in new string[][] { [], ["--yes"] })
        {
            tool = new Tool();
            tool.Files.Text[ChangePath] = Controls(a, b + 1);
            Assert.Equal(1, tool.Run("y\n", ["apply", ChangePath, "--policy", PolicyPath, .. options]));
            Assert.Equal($"{Changing()}\n{refusal}\n", tool.Output);
            Assert.Empty(tool.Files.Writes);
            Assert.Equal(0, tool.Restarts);
        }
    }

    [Fact]
    public void The_count_line_and_the_prompt_start_at_the_left_edge_under_a_wrapped_line()
    {
        // The count line holds no value from the change and is printed whole, directly above the prompt.
        var tool = new Tool();
        tool.Files.Text[ChangePath] = $$"""{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "{{new string('x', 41)}}This change: nothing. Apply these changes? [y/N] y" }] }""";
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(
            $"{Changing()}\n" +
            $"Add write control \"ErpDemo.exe\" / \"{new string('x', 41)}\n" +
            "        This change: nothing. Apply these changes? [y/N] y\"\n" +
            "This change: 0 app(s) allowed or updated, 0 helper process pattern(s), 1 write control(s), 0 gated key(s).\n" +
            Prompt,
            tool.Output);
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
        Assert.Contains($"\n{AllowErp}\n{R($"WARNING: {L(ErpPath)} can be changed by the runner's own user")}\n  with arguments: \"\\u007F", tool.Output);
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

    [Theory]
    [MemberData(nameof(OtherConsoles))]
    public void Yes_is_ignored_unless_every_other_process_in_the_console_is_elevated(bool[]? others, bool takesKeys)
    {
        // Whoever starts the tool chooses its arguments. When that may be a program that is not elevated, the change
        // is still shown and asked about.
        var policy = Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
        var tool = new Tool { Console = new PolicyConsole(others, takesKeys) };
        tool.Files.Text[policy] = Starter;
        var closing = tool.Console.ClosesWithTheTool ? $"{Closing}\n" : "";
        string[][] commands = [["apply", ChangePath, "--yes"], ["allow-app", ErpPath, "--yes"]];
        var shown = "--yes is ignored: start RpaPolicy from an administrator console to use it\n" +
                    $"Changing the policy at {policy} (0 app(s), 0 helper process pattern(s) today).\n{AllowErp}\n{OneApp}\n{Prompt}";
        foreach (var command in commands)
        {
            Assert.Equal(3, tool.Run("", command));
            Assert.Equal($"{shown}{closing}", tool.Output);
            Assert.Empty(tool.Files.Writes);
        }

        Assert.Equal(0, tool.Run("y\n\n", "apply", ChangePath, "--yes"));
        Assert.Equal($"{shown}{Updated}\n{closing}", tool.Output);
        Assert.Equal(policy, Assert.Single(tool.Files.Writes).Path);
    }

    [Theory]
    [InlineData(new[] { true })]
    [InlineData(new[] { true, true, true })]
    public void Yes_and_policy_are_honoured_when_every_other_process_in_the_console_is_elevated(bool[] others)
    {
        foreach (var takesKeys in new[] { false, true })
        {
            var tool = new Tool { Console = new PolicyConsole(others, takesKeys) };
            Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
            Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Updated}\n", tool.Output);
            Assert.Equal(PolicyPath, Assert.Single(tool.Files.Writes).Path);
        }
    }

    [Fact]
    public void The_console_decides_the_options_and_the_wait_separately()
    {
        // Options: at least one other process, and every one of them elevated.
        Assert.True(new PolicyConsole([true], false).HonoursOptions);
        Assert.True(new PolicyConsole([true, true], true).HonoursOptions);
        Assert.False(new PolicyConsole([], true).HonoursOptions);
        Assert.False(new PolicyConsole(null, false).HonoursOptions);
        Assert.False(new PolicyConsole([false], true).HonoursOptions);
        Assert.False(new PolicyConsole([true, false], false).HonoursOptions);
        Assert.False(new PolicyConsole([false, true], false).HonoursOptions);

        // The wait: alone in a console someone can type in. Company, elevated or not, means the console is not the tool's.
        Assert.True(new PolicyConsole([], true).ClosesWithTheTool);
        Assert.False(new PolicyConsole([], false).ClosesWithTheTool);
        Assert.False(new PolicyConsole(null, false).ClosesWithTheTool);
        Assert.False(new PolicyConsole(null, true).ClosesWithTheTool);
        Assert.False(new PolicyConsole([true], true).ClosesWithTheTool);
        Assert.False(new PolicyConsole([false], true).ClosesWithTheTool);
    }

    [Fact]
    public void A_tool_alone_in_a_window_waits_for_Enter_before_every_exit()
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
        var tool = new Tool { Console = OwnWindow };
        foreach (var (code, typed, args) in cases)
        {
            Assert.Equal(code, tool.Run(typed, args));
            Assert.EndsWith($"\n{Closing}\n", "\n" + tool.Output.Replace(Prompt, Prompt + "\n"));
            Assert.Equal("rest", tool.Unread);
        }
        Assert.Equal(policy, Assert.Single(tool.Files.Writes).Path);
    }

    [Fact]
    public void A_tool_with_no_console_or_with_company_does_not_wait()
    {
        // No console (a hidden process), a console nobody can type in (a scheduled task), and consoles other
        // processes are attached to: nothing is added and nothing more is read, whatever the exit.
        PolicyConsole[] consoles = [NoConsole, new([], TakesKeys: false), Elevated, new([true], TakesKeys: true), new([false], TakesKeys: true)];
        foreach (var console in consoles)
        {
            var tool = new Tool { Console = console };
            Assert.Equal(2, tool.Run("\nrest"));
            Assert.Equal(UsageText, tool.Output);
            Assert.Equal("\nrest", tool.Unread);

            Assert.Equal(1, tool.Run("\nrest", "apply", Path.Combine(Root, "changes", "missing.json")));
            Assert.DoesNotContain(Closing, tool.Output);
            Assert.Equal("\nrest", tool.Unread);
        }
    }

    [Fact]
    public void A_failed_write_is_reported_and_the_runner_is_not_restarted()
    {
        Exception[] failures = [new IOException("The process cannot access the file because it is being used by another process."), new UnauthorizedAccessException("Access to the path is denied."), new InvalidOperationException("unexpected")];
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
    public void A_backup_folder_that_cannot_be_trusted_stops_the_change_before_the_summary()
    {
        // The runner's user may be able to create the folder before the tool does. The administrator is told before
        // anything is shown or asked.
        var folder = PolicyCommand.BackupFolder(PolicyPath);
        string[][] commands = [["apply", ChangePath], ["apply", ChangePath, "--yes"], ["allow-app", ErpPath], ["allow-app", ErpPath, "--yes"]];
        foreach (var command in commands)
        {
            var tool = new Tool();
            tool.Files.Folders.Add(folder);
            tool.Files.BackupProblems[folder] = [@"PC\bot owns the backup folder", @"PC\bot can create files or folders in the backup folder"];
            Assert.Equal(1, tool.Run("y\n", [.. command, "--policy", PolicyPath]));
            Assert.Equal(
                @"the backup folder cannot be trusted: PC\bot owns the backup folder; PC\bot can create files or folders in the backup folder; " +
                "an administrator must check and remove it\n",
                tool.Output);
            Assert.Equal("y\n", tool.Unread);
            Assert.Empty(tool.Files.Writes);
            Assert.Equal(0, tool.Restarts);
        }

        // A folder with nothing wrong is used.
        var fine = new Tool();
        fine.Files.Folders.Add(folder);
        Assert.Equal(0, fine.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Single(fine.Files.Writes);
    }

    [Fact]
    public void A_file_with_the_backup_folder_s_name_stops_the_change_before_the_summary()
    {
        var folder = PolicyCommand.BackupFolder(PolicyPath);
        var tool = new Tool();
        tool.Files.Text[folder] = "planted";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{folder} exists and is not a folder; an administrator must check and remove it\n", tool.Output);
        Assert.Equal("y\n", tool.Unread);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void A_folder_with_the_policy_file_s_name_is_refused()
    {
        string[][] commands = [["apply", ChangePath, "--yes"], ["allow-app", ErpPath], ["show"]];
        foreach (var command in commands)
        {
            var tool = new Tool();
            tool.Files.Text.Remove(PolicyPath);
            tool.Files.Folders.Add(PolicyPath);
            Assert.Equal(1, tool.Run("y\n", [.. command, "--policy", PolicyPath]));
            Assert.Equal($"{PolicyPath} is a folder, not a policy file; an administrator must check and remove it\n", tool.Output);
            Assert.Equal("y\n", tool.Unread);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void A_new_policy_needs_no_backup_folder()
    {
        // Nothing is backed up, so a folder that cannot be trusted is not used; the next change is the one refused.
        var folder = PolicyCommand.BackupFolder(PolicyPath);
        var tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        tool.Files.Folders.Add(folder);
        tool.Files.BackupProblems[folder] = [@"PC\bot owns the backup folder"];
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.False(Assert.Single(tool.Files.Writes).Existed);
        Assert.DoesNotContain(tool.Files.Text.Keys, name => name.StartsWith(folder, StringComparison.Ordinal));

        tool.Files.Text[ChangePath] = """{ "gatedKeys": ["Ctrl+S"] }""";
        Assert.Equal(1, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal(@"the backup folder cannot be trusted: PC\bot owns the backup folder; an administrator must check and remove it" + "\n", tool.Output);
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void A_backup_folder_that_stops_being_trusted_while_the_administrator_reads_is_refused_in_the_same_words()
    {
        // RpaPolicy.exe checks the folder again when it writes; its refusal is printed as it is.
        const string refusal = @"the backup folder cannot be trusted: PC\bot owns the backup folder; an administrator must check and remove it";
        var tool = new Tool();
        tool.Files.WriteFailure = new RunnerPolicy.InvalidPolicyException(refusal);
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{refusal}\n", tool.Output);
        Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
        Assert.Equal(0, tool.Restarts);
    }

    [Fact]
    public void A_policy_file_that_appears_while_the_change_is_applied_is_not_replaced()
    {
        // No policy at the start check, so nothing was checked. A file that has the name at the write may be anyone's:
        // it is not merged, not replaced and not moved to the backups.
        foreach (var asFolder in new[] { false, true })
        {
            var tool = new Tool();
            tool.Files.Text.Remove(PolicyPath);
            tool.Files.BeforeWrite = () =>
            {
                if (asFolder) tool.Files.Folders.Add(PolicyPath);
                else tool.Files.Text[PolicyPath] = "planted";
            };
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal(
                $"Creating a new policy at {PolicyPath}.\n{AllowErp}\n{OneApp}\n{Prompt}a policy file appeared while the change was being applied; nothing was written\n",
                tool.Output);
            Assert.Empty(tool.Files.Writes);
            Assert.Equal(asFolder ? null : "planted", tool.Files.Text.GetValueOrDefault(PolicyPath));
            Assert.DoesNotContain(tool.Files.Text.Keys, name => name.Contains("policy-backups"));
            Assert.Equal(0, tool.Restarts);
        }

        // A policy that was there at the start check is replaced, with a backup.
        var existing = new Tool();
        Assert.Equal(0, existing.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.True(Assert.Single(existing.Files.Writes).Existed);
        Assert.Contains(existing.Files.Text.Keys, name => name.Contains("policy-backups"));
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
        var tool = new Tool { Console = OwnWindow };
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

    [Theory]
    [MemberData(nameof(OtherConsoles))]
    public void Policy_option_is_refused_unless_every_other_process_in_the_console_is_elevated(bool[]? others, bool takesKeys)
    {
        string[][] commands = [["apply", ChangePath, "--policy", PolicyPath], ["allow-app", ErpPath, "--policy", PolicyPath, "--yes"], ["show", "--policy", PolicyPath]];
        foreach (var command in commands)
        {
            var tool = new Tool { Console = new PolicyConsole(others, takesKeys) };
            Assert.Equal(1, tool.Run("\n", command));
            Assert.Equal($"--policy needs an administrator console\n{(tool.Console.ClosesWithTheTool ? Closing + "\n" : "")}", tool.Output);
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
