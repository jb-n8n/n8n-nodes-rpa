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

    /// <summary>Summary lines, refusals and failures as the tool prints them: a line longer than 76 characters in
    /// rows (PolicyChangeTests has the rows spelled out).</summary>
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
        /// <summary>Every time the policy file got new content: by the swap (it existed) or by the move of a new file.</summary>
        public List<(string Path, string Json, bool Existed)> Writes { get; } = [];
        public List<string> Reads { get; } = [];

        /// <summary>Every open of a file whose path the caller chose (a change file, an application), with the
        /// stream that was handed out.</summary>
        public List<(string Path, OneWayStream Stream)> Opened { get; } = [];

        /// <summary>What a test says the open of a path finds (a pipe, a folder, a link, a network drive). A path
        /// that is not here opens as a regular file on a local drive.</summary>
        public Dictionary<string, (bool DiskFile, bool Folder, bool Link, bool LocalFixedDrive)> Found { get; } = [];

        /// <summary>Every path whose kind was asked for.</summary>
        public List<string> Looked { get; } = [];

        /// <summary>What Windows says about a drive: the device its letter stands for (null: no such letter) and
        /// whether its type is fixed. A root that is not here is a volume on a fixed drive.</summary>
        public Dictionary<string, (string? Device, bool Fixed)> Drives { get; } = [];

        /// <summary>The names that are links (or cannot be read).</summary>
        public HashSet<string> Links { get; } = [];

        /// <summary>Every name that was asked about on the way down a path, in order.</summary>
        public List<string> Walked { get; } = [];

        /// <summary>Every drive whose type was asked for (asking opens the drive).</summary>
        public List<string> TypeAsked { get; } = [];

        public string? DriveDevice(string root) => Drives.TryGetValue(root, out var drive) ? drive.Device : @"\Device\HarddiskVolume3";

        public bool FixedDrive(string root)
        {
            TypeAsked.Add(root);
            return !Drives.TryGetValue(root, out var drive) || drive.Fixed;
        }

        public bool IsLink(string path)
        {
            Walked.Add(path);
            return Links.Contains(path);
        }

        /// <summary>What the runner's start check says about a file; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> Untrusted { get; } = [];

        /// <summary>What the start check says about a file once the tool has written it.</summary>
        public string[] UntrustedAfterWrite { get; set; } = [];

        public List<string> Checked { get; } = [];

        /// <summary>What is wrong with a backup folder; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> BackupProblems { get; } = [];

        /// <summary>The steps of a write that fail, each with what it fails with: "temporary", "folder", "backup",
        /// "replace", "move", "inherit", "delete", "read".</summary>
        public Dictionary<string, Exception> Failures { get; } = [];

        /// <summary>Every step of a write that ran, in order, with the path it was given.</summary>
        public List<string> Steps { get; } = [];

        /// <summary>Runs after the backup copy was made (something that happens directly before the swap).</summary>
        public Action? AfterBackup { get; set; }

        private void Step(string step, string path)
        {
            Steps.Add($"{step} {path}");
            if (Failures.TryGetValue(step, out var failure)) throw failure;
        }

        public IReadOnlyList<string> Problems(string path)
        {
            Checked.Add(path);
            return Untrusted.GetValueOrDefault(path, []);
        }

        public IReadOnlyList<string> BackupFolderProblems(string folder) => BackupProblems.GetValueOrDefault(folder, []);

        /// <summary>What is wrong with the folder for change copies; nothing unless a test puts it here.</summary>
        public Dictionary<string, string[]> ChangeProblems { get; } = [];

        public IReadOnlyList<string> ChangeFolderProblems(string folder) => ChangeProblems.GetValueOrDefault(folder, []);

        /// <summary>The copies apply made of change files, by path (kept apart from the other files, so that the tests
        /// of the policy's own files see only those).</summary>
        public Dictionary<string, byte[]> Copies { get; } = [];

        /// <summary>When set, writing a copy fails with it.</summary>
        public Exception? CopyFailure { get; set; }

        /// <summary>Runs after a copy was written.</summary>
        public Action<string>? AfterCopy { get; set; }

        public void CreateChangeFolder(string folder) => Folders.Add(folder);

        public void CreateChangeCopy(string path, byte[] content)
        {
            if (CopyFailure is not null) throw CopyFailure;
            if (Kind(path) != PathKind.None) throw new IOException("The file exists.");
            Copies[path] = content.ToArray();
            AfterCopy?.Invoke(path);
        }

        public PathKind Kind(string path)
        {
            Looked.Add(path);
            var kind = Folders.Contains(path) ? PathKind.Folder : Text.ContainsKey(path) || Bytes.ContainsKey(path) || Copies.ContainsKey(path) ? PathKind.File : PathKind.None;
            if (AfterLook is { } after && Steps.Count > 0 && Steps[^1].StartsWith("replace", StringComparison.Ordinal))
            {
                AfterLook = null;
                after();
            }
            return kind;
        }

        public byte[]? ReadBytes(string path)
        {
            Reads.Add(path);
            if (Text.ContainsKey(path) && Failures.TryGetValue("read", out var failure)) throw failure;
            if (Copies.TryGetValue(path, out var copy)) return copy;
            return Bytes.TryGetValue(path, out var bytes) ? bytes : Text.TryGetValue(path, out var text) ? Encoding.UTF8.GetBytes(text) : null;
        }

        /// <summary>A size to report in place of the text's own (a file that grows after its size was read).</summary>
        public Dictionary<string, long> Sizes { get; } = [];

        public string CreateTemporary(string policyPath, byte[] content)
        {
            var temporary = policyPath + ".0123456789ABCDEF0123456789ABCDEF.tmp";
            Step("temporary", temporary);
            Text[temporary] = Encoding.UTF8.GetString(content);
            return temporary;
        }

        public void CreateBackupFolder(string folder)
        {
            Step("folder", folder);
            Folders.Add(folder);
        }

        public void CreateBackup(string backupPath, byte[] content)
        {
            Step("backup", backupPath);
            if (Kind(backupPath) != PathKind.None) throw new IOException("The file exists.");
            Text[backupPath] = Encoding.UTF8.GetString(content);
            AfterBackup?.Invoke();
        }

        /// <summary>Runs when the swap starts (the state a failing swap leaves behind is set here).</summary>
        public Action? AfterSwapCheck { get; set; }

        /// <summary>Runs once, after the tool has looked at what a failed swap left under the policy's name.</summary>
        public Action? AfterLook { get; set; }

        public void Replace(string temporary, string policyPath)
        {
            AfterSwapCheck?.Invoke();
            Step("replace", policyPath);
            Writes.Add((policyPath, Text[temporary], true));
            Text[policyPath] = Text[temporary];
            Text.Remove(temporary);
            if (UntrustedAfterWrite.Length > 0) Untrusted[policyPath] = UntrustedAfterWrite;
        }

        public void MoveNew(string from, string to)
        {
            Step("move", to);
            if (Folders.Contains(to) || Text.ContainsKey(to)) throw new IOException("Cannot create a file when that file already exists.");
            Text[to] = Text[from];
            Text.Remove(from);
            if (from.EndsWith(".tmp", StringComparison.Ordinal))
            {
                Writes.Add((to, Text[to], false));
                if (UntrustedAfterWrite.Length > 0) Untrusted[to] = UntrustedAfterWrite;
            }
        }

        public void InheritPermissions(string path) => Step("inherit", path);

        public void Delete(string path)
        {
            Step("delete", path);
            Text.Remove(path);
        }

        public OpenedFile? Open(string path)
        {
            var bytes = Bytes.TryGetValue(path, out var binary) ? binary : Text.TryGetValue(path, out var text) ? Encoding.UTF8.GetBytes(text) : null;
            if (bytes is null && !Folders.Contains(path) && !Found.ContainsKey(path)) return null;
            var stream = new OneWayStream(bytes ?? []);
            Opened.Add((path, stream));
            var found = Found.TryGetValue(path, out var odd) ? odd : (DiskFile: true, Folder: Folders.Contains(path), Link: false, LocalFixedDrive: true);
            return new OpenedFile(found.DiskFile, found.Folder, found.Link, found.LocalFixedDrive, Sizes.TryGetValue(path, out var size) ? size : stream.Size, stream);
        }
    }

    /// <summary>A file as a stream that can only be read forward, a piece at a time: no length, no position.</summary>
    private sealed class OneWayStream(byte[] bytes) : Stream
    {
        private int _at;

        public int Size => bytes.Length;
        public int BytesRead => _at;
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
    private static readonly PolicyConsole Elevated = new([true], TakesKeys: false, Buffer: () => null);
    private static readonly PolicyConsole OwnWindow = new([], TakesKeys: true, Buffer: () => null);
    private static readonly PolicyConsole NoConsole = new(null, TakesKeys: false, Buffer: () => null);

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

        /// <summary>Runs when the tool reads the answer to its prompt (something that happens while the
        /// administrator reads the summary).</summary>
        public Action? AtPrompt { get; set; }

        private sealed class Typed(string typed, Func<Action?> atPrompt) : StringReader(typed)
        {
            public override string? ReadLine()
            {
                atPrompt()?.Invoke();
                return base.ReadLine();
            }
        }

        public Tool()
        {
            Files.Text[PolicyPath] = Starter;
            Files.Text[ChangePath] = Change;
        }

        public int Run(string typed, params string[] args)
        {
            var output = new StringWriter { NewLine = "\n" };
            var input = new Typed(typed, () => AtPrompt);
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
        Assert.Equal(ErpPath, Assert.Single(RunnerPolicy.Parse(write.Json).AllowedApps).Path);
        Assert.Equal(1, tool.Restarts);

        // The policy from before the change is in the backup folder, under the time of the write; nothing else is left.
        var backup = Assert.Single(tool.Files.Text.Keys, name => name.StartsWith(PolicyCommand.BackupFolder(PolicyPath), StringComparison.Ordinal));
        Assert.Contains(backup, new[] { before, DateTimeOffset.Now }.Select(time => PolicyCommand.BackupPath(PolicyPath, time, _ => false)));
        Assert.Equal(Starter, tool.Files.Text[backup]);
        Assert.Equal(write.Json, tool.Files.Text[PolicyPath]);
        Assert.DoesNotContain(tool.Files.Text.Keys, name => name.EndsWith(".tmp", StringComparison.Ordinal));
    }

    [Fact]
    public void Apply_first_copies_the_change_file_into_its_own_folder_and_applies_the_copy()
    {
        // The change file may be in a folder its user can change (Documents, where the recorder saves): the tool works
        // from a copy in a folder of its own that only administrators can change.
        var tool = new Tool();
        var before = DateTimeOffset.Now;
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{Updated}\n", tool.Output);
        var folder = PolicyCommand.ChangeFolder(PolicyPath);
        Assert.Equal(Path.Combine(Path.GetDirectoryName(PolicyPath)!, "policy-changes"), folder);
        Assert.Contains(folder, tool.Files.Folders);
        var copy = Assert.Single(tool.Files.Copies);
        Assert.Contains(copy.Key, new[] { before, DateTimeOffset.Now }.Select(time => PolicyCommand.ChangeCopyPath(PolicyPath, "change.json", time, _ => false)));
        Assert.Equal(Change, Encoding.UTF8.GetString(copy.Value));
        // The change file itself is opened once, as before, and the copy is what is read for the summary.
        Assert.Single(tool.Files.Opened);
        Assert.Contains(copy.Key, tool.Files.Reads);

        // Each apply keeps its own copy.
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(2, tool.Files.Copies.Count);
    }

    [Fact]
    public void What_is_shown_and_applied_is_the_copy_and_a_change_file_changed_meanwhile_changes_nothing()
    {
        var other = $$"""{ "allowedApps": [{ "exe": "Other.exe", "path": {{J(Path.Combine(Root, "Other", "Other.exe"))}} }] }""";
        var tool = new Tool();
        // Whoever owns the folder of the change file changes it while the administrator reads the summary.
        tool.AtPrompt = () => tool.Files.Text[ChangePath] = other;
        Assert.Equal(0, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(ErpPath, Assert.Single(RunnerPolicy.Parse(Assert.Single(tool.Files.Writes).Json).AllowedApps).Path);
        Assert.Equal(Change, Encoding.UTF8.GetString(Assert.Single(tool.Files.Copies).Value));

        // The summary and the write come from the copy as it is in the tool's folder.
        var read = new Tool();
        read.Files.AfterCopy = path => read.Files.Copies[path] = Encoding.UTF8.GetBytes(other);
        Assert.Equal(0, read.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Contains("Allow app \"Other.exe\"", read.Output);
        Assert.Equal("Other.exe", Assert.Single(RunnerPolicy.Parse(Assert.Single(read.Files.Writes).Json).AllowedApps).Exe);
    }

    [Fact]
    public void A_change_folder_that_cannot_be_trusted_stops_apply_before_the_summary()
    {
        // The runner's user may be able to create the folder before the tool does.
        var folder = PolicyCommand.ChangeFolder(PolicyPath);
        var tool = new Tool();
        tool.Files.Folders.Add(folder);
        tool.Files.ChangeProblems[folder] = [@"PC\bot owns the change folder"];
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(R(@"the change folder cannot be trusted: PC\bot owns the change folder; an administrator must check and remove it") + "\n", tool.Output);
        Assert.Equal("y\n", tool.Unread);
        Assert.Empty(tool.Files.Copies);
        Assert.Empty(tool.Files.Writes);

        var planted = new Tool();
        planted.Files.Text[folder] = "planted";
        Assert.Equal(1, planted.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{R($"{folder} exists and is not a folder; an administrator must check and remove it")}\n", planted.Output);
        Assert.Empty(planted.Files.Copies);
        Assert.Empty(planted.Files.Writes);
    }

    [Fact]
    public void A_copy_that_cannot_be_written_stops_apply_with_nothing_changed()
    {
        var tool = new Tool();
        tool.Files.CopyFailure = new UnauthorizedAccessException("Access to the path is denied.");
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(R($"The change file could not be copied to {PolicyCommand.ChangeFolder(PolicyPath)}: Access to the path is denied. Nothing was changed.") + "\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);
    }

    [Fact]
    public void Nothing_is_copied_for_a_change_file_that_is_refused_or_for_allow_app()
    {
        var tool = new Tool();
        Assert.Equal(1, tool.Run("y\n", "apply", Path.Combine(Root, "changes", "missing.json"), "--policy", PolicyPath));
        tool.Files.Text[ChangePath] = new string(' ', (int)PolicyCommand.MaxChangeFileBytes + 1);
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(0, tool.Run("y\n", "allow-app", ErpPath, "--policy", PolicyPath));
        Assert.Empty(tool.Files.Copies);
        Assert.DoesNotContain(PolicyCommand.ChangeFolder(PolicyPath), tool.Files.Folders);
    }

    [Fact]
    public void A_copy_is_named_after_the_change_file_and_the_time_and_never_replaces_another()
    {
        var at = new DateTimeOffset(2026, 11, 11, 14, 47, 0, TimeSpan.Zero);
        var folder = PolicyCommand.ChangeFolder(PolicyPath);
        Assert.Equal(Path.Combine(folder, "erp.policy-change.20261111-144700.json"), PolicyCommand.ChangeCopyPath(PolicyPath, "erp.policy-change.json", at, _ => false));
        Assert.Equal(Path.Combine(folder, "notes.txt.20261111-144700.json"), PolicyCommand.ChangeCopyPath(PolicyPath, "notes.txt", at, _ => false));
        var first = Path.Combine(folder, "a.20261111-144700.json");
        Assert.Equal(Path.Combine(folder, "a.20261111-144700-2.json"), PolicyCommand.ChangeCopyPath(PolicyPath, "a.JSON", at, name => name == first));
        Assert.Equal(Path.Combine(folder, new string('x', 100) + ".20261111-144700.json"), PolicyCommand.ChangeCopyPath(PolicyPath, new string('x', 150) + ".json", at, _ => false));
        // A name that holds a stream (change.json:more) or another character Windows refuses in a file name is not
        // taken as it is: the copy is one plain file.
        Assert.Equal(Path.Combine(folder, "change.json_more.20261111-144700.json"), PolicyCommand.ChangeCopyPath(PolicyPath, "change.json:more", at, _ => false));
        Assert.Equal(Path.Combine(folder, "a_b_c.20261111-144700.json"), PolicyCommand.ChangeCopyPath(PolicyPath, "a?b\u0001c.json", at, _ => false));
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
        Assert.Equal($"{R($"Application file not found: {missing}")}\n", tool.Output);
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
            Assert.Equal($"{R(refusal)}\n", tool.Output);
            Assert.Empty(tool.Files.Opened);
            Assert.Empty(tool.Files.Looked);
            Assert.Empty(tool.Files.Walked);
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
            Assert.Equal($"{R($"write the full path, not a short (8.3) name: {L(target)}")}\n", tool.Output);
            Assert.Empty(tool.Files.Opened);
            Assert.Empty(tool.Files.Looked);
            Assert.Empty(tool.Files.Walked);
            Assert.Empty(tool.Files.Writes);
        }
    }

    [Fact]
    public void A_missing_change_file_exits_1_and_names_it()
    {
        var tool = new Tool();
        var missing = Path.Combine(Root, "changes", "missing.json");
        Assert.Equal(1, tool.Run("y\n", "apply", missing, "--policy", PolicyPath));
        Assert.Equal($"{R($"Change file not found: {missing}")}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void A_change_file_larger_than_256_KiB_is_refused_before_it_is_read()
    {
        var tool = new Tool();
        tool.Files.Text[ChangePath] = Change + new string(' ', 256 * 1024 - Change.Length);
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(256 * 1024, Assert.Single(tool.Files.Opened).Stream.BytesRead);

        tool.Files.Opened.Clear();
        tool.Files.Text[ChangePath] += " ";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("the change file is larger than 256 KiB\n", tool.Output);
        var (_, unread) = Assert.Single(tool.Files.Opened);
        Assert.Equal(0, unread.BytesRead);
        Assert.True(unread.Closed);

        // A file that says it is small and gives more is refused as well, after one byte more than the limit.
        tool.Files.Opened.Clear();
        tool.Files.Sizes[ChangePath] = 100;
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal("the change file is larger than 256 KiB\n", tool.Output);
        Assert.Equal(256 * 1024 + 1, Assert.Single(tool.Files.Opened).Stream.BytesRead);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void A_change_file_is_opened_once_and_read_in_the_encoding_its_first_bytes_name()
    {
        // As Windows PowerShell writes files: UTF-16 with a byte order mark (Out-File), UTF-8 with one (Set-Content).
        Encoding[] encodings = [new UTF8Encoding(false), new UTF8Encoding(true), new UnicodeEncoding(false, true), new UnicodeEncoding(true, true)];
        foreach (var encoding in encodings)
        {
            var tool = new Tool();
            tool.Files.Text.Remove(ChangePath);
            tool.Files.Bytes[ChangePath] = [.. encoding.GetPreamble(), .. encoding.GetBytes(Change)];
            Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}", tool.Output);
            var (path, stream) = Assert.Single(tool.Files.Opened);
            Assert.Equal(ChangePath, path);
            Assert.True(stream.Closed);
        }
    }

    /// <summary>What the open of a path the caller chose can find that is not a regular file on a local drive.</summary>
    public static TheoryData<bool, bool, bool, bool> NotRegular => new()
    {
        // disk file, folder, link, local fixed drive
        { false, false, false, false },  // a pipe or a device
        { true, true, false, true },     // a folder
        { true, false, true, true },     // a link (the last name of the path)
        { true, false, false, false },   // a file on a network share or a removable drive, or behind a link earlier in the path
        { true, true, true, false },     // a junction
    };

    [Theory]
    [MemberData(nameof(NotRegular))]
    public void A_file_the_caller_chose_is_read_only_when_it_is_a_regular_file_on_a_local_drive(bool diskFile, bool folder, bool link, bool localFixedDrive)
    {
        // The paths come from whoever started the tool. What was opened is looked at before a byte is read.
        string[][] commands = [["apply", ChangePath], ["allow-app", ErpPath, "--pin-hash"]];
        foreach (var command in commands)
        {
            var tool = new Tool();
            tool.Files.Bytes[ErpPath] = [1, 2, 3];
            tool.Files.Found[command[1]] = (diskFile, folder, link, localFixedDrive);
            Assert.Equal(1, tool.Run("y\n", [.. command, "--yes", "--policy", PolicyPath]));
            Assert.Equal($"{R($"{command[1]} is not a regular file on a local drive")}\n", tool.Output);
            var (path, stream) = Assert.Single(tool.Files.Opened);
            Assert.Equal(command[1], path);
            Assert.Equal(0, stream.BytesRead);
            Assert.True(stream.Closed);
            Assert.Empty(tool.Files.Writes);
        }
    }

    private static readonly string DriveRoot = Path.GetPathRoot(Root)!;

    /// <summary>The names on the way from the drive down to the path, the path itself last.</summary>
    private static List<string> Down(string path)
    {
        var names = new List<string>();
        for (var at = path; at != DriveRoot; at = Path.GetDirectoryName(at)!) names.Insert(0, at);
        return names;
    }

    /// <summary>The commands that take a path from the caller, each with the path it is given.</summary>
    private static (string[] Command, string Path)[] CallerPaths(string folder) =>
    [
        (["apply", Path.Combine(folder, "change.json")], Path.Combine(folder, "change.json")),
        (["allow-app", Path.Combine(folder, "ErpDemo.exe")], Path.Combine(folder, "ErpDemo.exe")),
        (["allow-app", Path.Combine(folder, "ErpDemo.exe"), "--pin-hash"], Path.Combine(folder, "ErpDemo.exe")),
    ];

    [Fact]
    public void A_path_with_a_link_in_it_is_refused_from_the_path_alone()
    {
        // A link earlier in the path would be followed by the open itself, to wherever it leads. Each name is asked
        // about from the drive downward, and nothing is asked or opened past the first link.
        var folder = Path.Combine(Root, "links", "inner", "deep");
        foreach (var (command, path) in CallerPaths(folder))
        {
            var names = Down(path);
            Assert.InRange(names.Count, 5, 6);
            for (var link = 0; link < names.Count; link++)
            {
                var tool = new Tool();
                tool.Files.Text[path] = Change;
                tool.Files.Links.Add(names[link]);
                Assert.Equal(1, tool.Run("y\n", [.. command, "--yes", "--policy", PolicyPath]));
                Assert.Equal($"{R($"{path} is not a regular file on a local drive")}\n", tool.Output);
                Assert.Equal(names.Take(link + 1), tool.Files.Walked);
                Assert.Empty(tool.Files.Opened);
                Assert.Empty(tool.Files.Looked);
                Assert.Empty(tool.Files.Writes);
            }
        }
    }

    [Fact]
    public void A_path_on_a_drive_that_is_not_a_fixed_volume_of_its_own_is_refused_from_the_path_alone()
    {
        // The device the letter stands for, whether its drive type is fixed, and whether the type is asked at all.
        (string? Device, bool Fixed, bool Asked)[] drives =
        [
            (@"\Device\LanmanRedirector\;Z:0000000000012345\server\share", false, true),  // a mapped network drive
            (@"\Device\HarddiskVolume9", false, true),                                     // a removable drive
            (@"\??\C:\Users\bot\apps", true, false),                                       // a letter subst made for a folder
            (@"\??\UNC\server\share", false, false),                                       // a letter subst made for a share
            ("", true, false),                                                              // a letter with no device name
            (null, true, false),                                                            // no such letter
        ];
        foreach (var (device, isFixed, asked) in drives)
        {
            foreach (var (command, path) in CallerPaths(Path.Combine(Root, "apps")))
            {
                var tool = new Tool();
                tool.Files.Text[path] = Change;
                tool.Files.Drives[DriveRoot] = (device, isFixed);
                Assert.Equal(1, tool.Run("y\n", [.. command, "--yes", "--policy", PolicyPath]));
                Assert.Equal($"{R($"{path} is not a regular file on a local drive")}\n", tool.Output);
                // The drive is opened for its type only when its letter names a device of its own.
                Assert.Equal(asked ? [DriveRoot] : [], tool.Files.TypeAsked);
                Assert.Empty(tool.Files.Walked);
                Assert.Empty(tool.Files.Opened);
                Assert.Empty(tool.Files.Writes);
            }
        }
    }

    [Fact]
    public void A_plain_path_is_asked_about_name_by_name_before_it_is_opened_or_recorded()
    {
        var folder = Path.Combine(Root, "ERP Demo");
        foreach (var (command, path) in CallerPaths(folder))
        {
            var tool = new Tool();
            tool.Files.Text[path] = Change;
            Assert.Equal(0, tool.Run("", [.. command, "--yes", "--policy", PolicyPath]));
            Assert.Equal(Down(path), tool.Files.Walked);
            // The application is opened only for its hash; without --pin-hash its path is recorded unopened.
            Assert.Equal(command is ["allow-app", _] ? [] : [path], tool.Files.Opened.Select(opened => opened.Path));
            Assert.Single(tool.Files.Writes);
        }

        // A path that does not exist yet has no links either: allow-app records it, as before.
        var absent = new Tool();
        Assert.Equal(0, absent.Run("", "allow-app", Path.Combine(Root, "Not installed yet", "ErpDemo.exe"), "--yes", "--policy", PolicyPath));
        Assert.Single(absent.Files.Writes);
    }

    [Fact]
    public void The_refusal_of_a_file_names_the_path_as_the_caller_gave_it_with_control_characters_escaped()
    {
        var odd = Path.Combine(Root, "ERP\u0007 Demo", "ErpDemo.exe");
        var tool = new Tool();
        tool.Files.Found[odd] = (false, false, false, false);
        Assert.Equal(1, tool.Run("y\n", "allow-app", odd, "--pin-hash", "--policy", PolicyPath));
        Assert.Equal($"{R($"{odd.Replace("\u0007", "\\u0007")} is not a regular file on a local drive")}\n", tool.Output);

        tool.Files.Found[odd] = (true, false, true, true);
        Assert.Equal(1, tool.Run("y\n", "apply", odd, "--policy", PolicyPath));
        Assert.Equal($"{R($"{odd.Replace("\u0007", "\\u0007")} is not a regular file on a local drive")}\n", tool.Output);
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
                    Assert.Equal($"{Changing()}\n{R(refusal)}\n", tool.Output);
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
            Assert.Equal($"{Changing()}\n{R(refusal)}\n", tool.Output);
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
        Assert.Equal($"{Changing()}\n{R("the summary of this change would be longer than 8000 characters; split it into smaller changes")}\n", tool.Output);
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
        Assert.Equal($"{Changing()}\n{R("the change: maxFileBytes cannot be changed by a change (edit the policy file)")}\n", tool.Output);
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
                R(@"the existing policy file cannot be trusted: PC\bot owns the policy file; BUILTIN\Users can change or replace the policy file's folder; " +
                  "an administrator must check and replace it") + "\n",
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
            R(@"The policy file was written, but the runner will not start with it: PC\bot can change or replace the policy file. " +
              "The policy file and its folder must be changeable by administrators only.") + "\n",
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
        var tool = new Tool { Console = new PolicyConsole(others, takesKeys, () => null) };
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
            var tool = new Tool { Console = new PolicyConsole(others, takesKeys, () => null) };
            Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
            Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Updated}\n", tool.Output);
            Assert.Equal(PolicyPath, Assert.Single(tool.Files.Writes).Path);
        }
    }

    [Fact]
    public void The_console_decides_the_options_and_the_wait_separately()
    {
        // Options: at least one other process, and every one of them elevated.
        Assert.True(new PolicyConsole([true], false, () => null).HonoursOptions);
        Assert.True(new PolicyConsole([true, true], true, () => null).HonoursOptions);
        Assert.False(new PolicyConsole([], true, () => null).HonoursOptions);
        Assert.False(new PolicyConsole(null, false, () => null).HonoursOptions);
        Assert.False(new PolicyConsole([false], true, () => null).HonoursOptions);
        Assert.False(new PolicyConsole([true, false], false, () => null).HonoursOptions);
        Assert.False(new PolicyConsole([false, true], false, () => null).HonoursOptions);

        // The wait: alone in a console someone can type in. Company, elevated or not, means the console is not the tool's.
        Assert.True(new PolicyConsole([], true, () => null).ClosesWithTheTool);
        Assert.False(new PolicyConsole([], false, () => null).ClosesWithTheTool);
        Assert.False(new PolicyConsole(null, false, () => null).ClosesWithTheTool);
        Assert.False(new PolicyConsole(null, true, () => null).ClosesWithTheTool);
        Assert.False(new PolicyConsole([true], true, () => null).ClosesWithTheTool);
        Assert.False(new PolicyConsole([false], true, () => null).ClosesWithTheTool);
    }

    /// <summary>The rows a line takes in a window 77 columns wide.</summary>
    private static int Rows77(string line) => line.Length / 77 + 1;

    private static string CannotShow(int rows) =>
        $"This window cannot show the whole summary (it needs {rows} rows and 77 columns). Start RpaPolicy from an administrator console and run the command again.";

    [Fact]
    public void A_window_that_cannot_show_the_whole_summary_is_not_asked()
    {
        // Whoever started the tool may have chosen the size of its window's buffer. The first line, the summary rows
        // and the count line, as a window 77 columns wide shows them, and one row for the prompt.
        var needed = Rows77(Changing()) + 1 + Rows77(OneApp) + 1;
        Assert.InRange(needed, 5, 7);
        (int Columns, int Rows)[] small = [(76, 9001), (40, 300), (77, needed - 1), (120, needed - 1), (9001, 1), (0, 0)];
        foreach (var buffer in small)
        {
            // In an administrator console, and where --policy is refused (the runner's own policy file is changed).
            foreach (var others in new bool[][] { [true], [false], [] })
            {
                var tool = new Tool { Console = new PolicyConsole(others, TakesKeys: false, () => buffer) };
                var policy = tool.Console.HonoursOptions ? PolicyPath : Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
                tool.Files.Text[policy] = Starter;
                var first = $"Changing the policy at {policy} (0 app(s), 0 helper process pattern(s) today).";
                string[][] commands = [["apply", ChangePath], ["allow-app", ErpPath]];
                foreach (var command in commands)
                {
                    Assert.Equal(1, tool.Run("y\n", [.. command, .. tool.Console.HonoursOptions ? new[] { "--policy", PolicyPath } : []]));
                    Assert.Equal($"{first}\n{R(CannotShow(Rows77(first) + 1 + Rows77(OneApp) + 1))}\n", tool.Output);
                    Assert.Equal("y\n", tool.Unread);
                    Assert.Empty(tool.Files.Writes);
                }
            }
        }

        // A window that holds every row is asked, and so is a tool whose output is not a console.
        (int Columns, int Rows)?[] enough = [(77, needed), (120, 9001), null];
        foreach (var buffer in enough)
        {
            var tool = new Tool { Console = new PolicyConsole([true], TakesKeys: false, () => buffer) };
            Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}", tool.Output);
        }
    }

    [Fact]
    public void The_rows_a_window_needs_are_those_of_the_whole_summary()
    {
        // 28 write controls of 200 characters: each is four rows, and the first line and the count line are two each
        // in 77 columns.
        var tool = new Tool();
        tool.Files.Text[ChangePath] = "{ \"writeControls\": [" +
            string.Join(", ", Enumerable.Range(0, 28).Select(i => $"{{ \"exe\": \"ErpDemo.exe\", \"automationId\": \"{i:D2}{new string('x', 198)}\" }}")) + "] }";
        var count = "This change: 0 app(s) allowed or updated, 0 helper process pattern(s), 28 write control(s), 0 gated key(s).";
        var needed = Rows77(Changing()) + 28 * 4 + Rows77(count) + 1;
        tool.Console = new PolicyConsole([true], TakesKeys: false, () => (80, needed - 1));
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{R(CannotShow(needed))}\n", tool.Output);
        tool.Console = new PolicyConsole([true], TakesKeys: false, () => (80, needed));
        Assert.Equal(3, tool.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        // Printed: the first line, 28 lines of four rows, the count line and the prompt.
        Assert.Equal(1 + 28 * 4 + 1 + 1, tool.Output.Split('\n').Length);
    }

    [Fact]
    public void A_window_s_size_is_not_asked_about_when_the_tool_does_not_ask()
    {
        // --yes from an administrator console: nothing is asked, so nothing has to be read first.
        var tool = new Tool { Console = new PolicyConsole([true], TakesKeys: false, () => (40, 3)) };
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Updated}\n", tool.Output);
        Assert.Equal(0, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.EndsWith("Nothing to change.\n", tool.Output);
        Assert.Equal(0, tool.Run("", "show", "--policy", PolicyPath));

        // The size is read once, when the tool is about to ask: not for a command that ends earlier.
        var asked = 0;
        var counting = new Tool { Console = new PolicyConsole([true], TakesKeys: false, () => { asked++; return (120, 9001); }) };
        Assert.Equal(1, counting.Run("", "apply", Path.Combine(Root, "changes", "missing.json"), "--policy", PolicyPath));
        Assert.Equal(0, counting.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal(0, counting.Run("", "apply", ChangePath, "--policy", PolicyPath));
        Assert.EndsWith("Nothing to change.\n", counting.Output);
        Assert.Equal(0, asked);
        counting.Files.Text[ChangePath] = """{ "gatedKeys": ["Ctrl+S"] }""";
        Assert.Equal(3, counting.Run("n\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(1, asked);

        // A --yes that is ignored still asks, so the window is looked at; and the tool's own window waits for Enter.
        var policy = Path.Combine(RunnerOptions.DefaultDataDir(), "policy.json");
        var own = new Tool { Console = new PolicyConsole([], TakesKeys: true, () => (80, 3)) };
        own.Files.Text[policy] = Starter;
        Assert.Equal(1, own.Run("y\n", "apply", ChangePath, "--yes"));
        var first = $"Changing the policy at {policy} (0 app(s), 0 helper process pattern(s) today).";
        Assert.Equal(
            "--yes is ignored: start RpaPolicy from an administrator console to use it\n" +
            $"{first}\n{R(CannotShow(Rows77(first) + 1 + Rows77(OneApp) + 1))}\n{Closing}\n",
            own.Output);
        Assert.Empty(own.Files.Writes);
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
        PolicyConsole[] consoles = [NoConsole, new([], TakesKeys: false, Buffer: () => null), Elevated, new([true], TakesKeys: true, Buffer: () => null), new([false], TakesKeys: true, Buffer: () => null)];
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
            tool.Files.Failures["replace"] = failure;
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal(
                $"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{R($"Writing the policy failed: {failure.Message.TrimEnd('.')}. The runner keeps running with the policy it has.")}\n",
                tool.Output);
            Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
            Assert.Equal(0, tool.Restarts);
        }
    }

    private static readonly string Temporary = PolicyPath + ".0123456789ABCDEF0123456789ABCDEF.tmp";
    private static readonly IOException SwapFailure = new("Unable to move the replacement file to the file to be replaced. The file to be replaced has retained its original name.");
    private const string SwapFailed = "Writing the policy failed: Unable to move the replacement file to the file to be replaced. The file to be replaced has retained its original name";
    private const string OtherPolicy = """{ "allowedApps": [], "gatedKeys": ["Ctrl+S"] }""";

    /// <summary>A tool whose swap fails, after <paramref name="leaves"/> has put the files in the state the failed swap leaves.</summary>
    private static Tool FailedSwap(Action<FakeFiles>? leaves = null)
    {
        var tool = new Tool();
        tool.Files.Failures["replace"] = SwapFailure;
        // The state is set when the backup copy has been made and compared: directly before the swap fails.
        tool.Files.AfterSwapCheck = () => leaves?.Invoke(tool.Files);
        return tool;
    }

    private static string Backups(Tool tool) =>
        Assert.Single(tool.Files.Text.Keys, name => name.StartsWith(PolicyCommand.BackupFolder(PolicyPath), StringComparison.Ordinal));

    private static void AssertFailed(Tool tool, string message)
    {
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{R(message)}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
        Assert.Equal(0, tool.Restarts);
    }

    [Fact]
    public void A_failed_swap_that_left_the_policy_as_it_was_removes_the_temporary_file_and_keeps_the_backup()
    {
        var tool = FailedSwap();
        AssertFailed(tool, $"{SwapFailed}. The runner keeps running with the policy it has.");
        Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
        Assert.Equal(Starter, tool.Files.Text[Backups(tool)]);
        Assert.DoesNotContain(Temporary, tool.Files.Text.Keys);
    }

    [Fact]
    public void A_failed_swap_that_left_no_policy_file_gets_the_old_policy_back_from_the_backup_copy()
    {
        // Windows documents a failed replace after which the replaced file no longer exists. Nothing is deleted
        // until the old policy is back in its place.
        var tool = FailedSwap(files => files.Text.Remove(PolicyPath));
        AssertFailed(tool,
            $"{SwapFailed}. After the failed swap there was no policy file at {PolicyPath}; the tool put the old policy back there from its backup copy, " +
            "with the permissions its folder gives.");
        Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
        Assert.Equal(2, tool.Files.Text.Count);
        Assert.Contains(ChangePath, tool.Files.Text.Keys);
        // In this order: the move back (which fails when something has the name), its permissions, and only then the
        // temporary file. The backup copy is moved, not deleted.
        var folder = PolicyCommand.BackupFolder(PolicyPath);
        Assert.Equal(7, tool.Files.Steps.Count);
        Assert.Equal([$"temporary {Temporary}", $"folder {folder}"], tool.Files.Steps.Take(2));
        Assert.StartsWith($"backup {Path.Combine(folder, "policy.json.")}", tool.Files.Steps[2]);
        Assert.Equal([$"replace {PolicyPath}", $"move {PolicyPath}", $"inherit {PolicyPath}", $"delete {Temporary}"], tool.Files.Steps.Skip(3));

        // The start check runs on the file that was put back, and what it finds is said.
        tool = FailedSwap(files =>
        {
            files.Text.Remove(PolicyPath);
            files.Untrusted[PolicyPath] = [@"PC\bot can change or replace the policy file"];
        });
        AssertFailed(tool,
            $"{SwapFailed}. After the failed swap there was no policy file at {PolicyPath}; the tool put the old policy back there from its backup copy, " +
            @"with the permissions its folder gives. The runner will not start with it: PC\bot can change or replace the policy file.");
    }

    [Fact]
    public void A_failed_swap_that_left_no_policy_file_and_a_failed_restore_leave_both_copies_and_say_where_they_are()
    {
        // The name is taken again by the time the tool moves the old policy back (the runner's user may create files
        // in the folder), or the move fails for another reason.
        Action<Tool>[] restoreFails =
        [
            tool => tool.Files.Failures["move"] = new UnauthorizedAccessException("Access to the path is denied."),
            tool => tool.Files.Failures["move"] = new IOException("The process cannot access the file because it is being used by another process."),
        ];
        foreach (var fail in restoreFails)
        {
            var tool = FailedSwap(files => files.Text.Remove(PolicyPath));
            fail(tool);
            var failure = tool.Files.Failures["move"].Message.TrimEnd('.');
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            var backup = Backups(tool);
            Assert.Equal(
                $"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}" +
                R($"{SwapFailed}. After the failed swap there is no policy file at {PolicyPath}, and putting the old policy back failed: {failure}. " +
                  $"The old policy is at {backup}. The changed policy, which was not applied, is at {Temporary}. " +
                  $"An administrator must put the old policy back at {PolicyPath}: the runner reads it when it starts.") + "\n",
                tool.Output);
            Assert.DoesNotContain("keeps running", tool.Output);
            Assert.Equal(Starter, tool.Files.Text[backup]);
            Assert.Equal(ErpPath, Assert.Single(RunnerPolicy.Parse(tool.Files.Text[Temporary]).AllowedApps).Path);
            Assert.DoesNotContain(PolicyPath, tool.Files.Text.Keys);
            Assert.DoesNotContain(tool.Files.Steps, step => step.StartsWith("delete", StringComparison.Ordinal));
            Assert.Equal(0, tool.Restarts);
        }

        // A file someone put under the name while the swap failed is not moved, replaced or merged.
        var planted = FailedSwap(files => files.Text.Remove(PolicyPath));
        planted.Files.AfterLook = () => planted.Files.Text[PolicyPath] = "planted";
        Assert.Equal(1, planted.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Contains("putting the old policy back failed: Cannot create a file when that file already exists. ", planted.Output.Replace("\n        ", ""));
        Assert.Equal("planted", planted.Files.Text[PolicyPath]);
        Assert.Equal(Starter, planted.Files.Text[Backups(planted)]);
        Assert.Contains(Temporary, planted.Files.Text.Keys);
    }

    [Fact]
    public void A_restored_policy_that_cannot_be_given_its_folder_s_permissions_is_reported()
    {
        var tool = FailedSwap(files => files.Text.Remove(PolicyPath));
        tool.Files.Failures["inherit"] = new UnauthorizedAccessException("Attempted to perform an unauthorized operation.");
        AssertFailed(tool,
            $"{SwapFailed}. After the failed swap there was no policy file at {PolicyPath}; the tool put the old policy back there from its backup copy, " +
            "but could not give it the permissions of its folder: Attempted to perform an unauthorized operation. " +
            "The runner's user may not be able to read it until an administrator sets them.");
        Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
        Assert.DoesNotContain(Temporary, tool.Files.Text.Keys);
    }

    [Fact]
    public void A_failed_swap_that_left_a_policy_file_the_tool_cannot_confirm_removes_nothing_and_says_where_the_copies_are()
    {
        // The file is there but holds something else, or cannot be read (on Windows a file that is being deleted
        // still has its name and cannot be opened). The tool cannot tell what it is, so both copies stay.
        Action<FakeFiles>[] leaves =
        [
            files => files.Text[PolicyPath] = OtherPolicy,
            files => files.Failures["read"] = new UnauthorizedAccessException("Access to the path is denied."),
        ];
        foreach (var leave in leaves)
        {
            var tool = FailedSwap(leave);
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            var backup = Backups(tool);
            Assert.Equal(
                $"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}" +
                R($"{SwapFailed}. The policy file at {PolicyPath} is still there, but the tool could not confirm that it is unchanged; look at it. " +
                  $"A copy of the old policy is at {backup}. The changed policy, which was not applied, is at {Temporary}.") + "\n",
                tool.Output);
            Assert.DoesNotContain("keeps running", tool.Output);
            Assert.Equal(Starter, tool.Files.Text[backup]);
            Assert.Equal(ErpPath, Assert.Single(RunnerPolicy.Parse(tool.Files.Text[Temporary]).AllowedApps).Path);
            Assert.DoesNotContain(tool.Files.Steps, step => step.StartsWith("delete", StringComparison.Ordinal));
            Assert.Equal(0, tool.Restarts);
        }

        // The temporary file is named only while it is there (a swap that reported a failure after it had moved it).
        var moved = FailedSwap(files =>
        {
            files.Text[PolicyPath] = files.Text[Temporary];
            files.Text.Remove(Temporary);
        });
        Assert.Equal(1, moved.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.EndsWith(
            R($"{SwapFailed}. The policy file at {PolicyPath} is still there, but the tool could not confirm that it is unchanged; look at it. " +
              $"A copy of the old policy is at {Backups(moved)}.") + "\n",
            moved.Output);
        Assert.Equal(0, moved.Restarts);
    }

    [Fact]
    public void A_policy_file_that_changed_while_the_administrator_read_the_summary_is_not_replaced()
    {
        // Another administrator changed the policy, or removed it, after the tool read it: the change shown was made
        // from the old text. Nothing is created, not even a backup.
        Action<FakeFiles>[] changes = [files => files.Text[PolicyPath] = OtherPolicy, files => files.Text[PolicyPath] = Starter + " ", files => files.Text.Remove(PolicyPath)];
        foreach (var change in changes)
        {
            var tool = new Tool();
            tool.AtPrompt = () => change(tool.Files);
            var expected = tool.Files.Text.Keys.Where(name => name != PolicyPath).ToList();
            AssertFailed(tool, "the policy file changed while this change was being applied; nothing was written");
            Assert.Empty(tool.Files.Steps);
            Assert.Equal(expected, tool.Files.Text.Keys.Where(name => name != PolicyPath));
        }

        // With --yes the tool does not wait, and still compares.
        var unchanged = new Tool();
        Assert.Equal(0, unchanged.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Single(unchanged.Files.Writes);
    }

    [Fact]
    public void A_policy_file_that_changed_between_the_backup_copy_and_the_swap_is_not_replaced()
    {
        var tool = new Tool();
        tool.Files.AfterBackup = () => tool.Files.Text[PolicyPath] = OtherPolicy;
        AssertFailed(tool, "the policy file changed while this change was being applied; nothing was written");
        Assert.Equal(OtherPolicy, tool.Files.Text[PolicyPath]);
        // The comparison is the last thing before the swap, and the swap is not tried. The backup copy stays.
        Assert.DoesNotContain(tool.Files.Steps, step => step.StartsWith("replace", StringComparison.Ordinal));
        Assert.Equal(Starter, tool.Files.Text[Backups(tool)]);
        Assert.DoesNotContain(Temporary, tool.Files.Text.Keys);
    }

    [Fact]
    public void A_write_that_fails_before_the_swap_leaves_the_policy_as_it_was()
    {
        foreach (var step in new[] { "temporary", "folder", "backup" })
        {
            var tool = new Tool();
            tool.Files.Failures[step] = new UnauthorizedAccessException("Access to the path is denied.");
            AssertFailed(tool, "Writing the policy failed: Access to the path is denied. The runner keeps running with the policy it has.");
            Assert.Equal([PolicyPath, ChangePath], tool.Files.Text.Keys);
            Assert.DoesNotContain(tool.Files.Steps, s => s.StartsWith("replace", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void A_temporary_file_that_cannot_be_removed_is_named()
    {
        var tool = FailedSwap();
        tool.Files.Failures["delete"] = new UnauthorizedAccessException("Access to the path is denied.");
        AssertFailed(tool, $"{SwapFailed}. The runner keeps running with the policy it has. The temporary file {Temporary} could not be removed: Access to the path is denied.");
    }

    [Fact]
    public void A_new_policy_that_cannot_be_moved_into_place_or_given_its_permissions_is_reported()
    {
        // There is no policy file, so the tool does not say the runner keeps one.
        var tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        tool.Files.Failures["move"] = new UnauthorizedAccessException("Access to the path is denied.");
        Assert.Equal(1, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.Equal($"Creating a new policy at {PolicyPath}.\n{AllowErp}\n{OneApp}\n{R("Writing the policy failed: Access to the path is denied. No policy file was written.")}\n", tool.Output);
        Assert.Equal([ChangePath], tool.Files.Text.Keys);
        Assert.Equal(0, tool.Restarts);

        foreach (var step in new[] { "temporary" })
        {
            tool = new Tool();
            tool.Files.Text.Remove(PolicyPath);
            tool.Files.Failures[step] = new IOException("There is not enough space on the disk.");
            Assert.Equal(1, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
            Assert.EndsWith($"\n{R("Writing the policy failed: There is not enough space on the disk. No policy file was written.")}\n", tool.Output);
            Assert.Equal([ChangePath], tool.Files.Text.Keys);
        }

        // The file is in place with the temporary file's permissions: said as it is, and the runner is not restarted.
        tool = new Tool();
        tool.Files.Text.Remove(PolicyPath);
        tool.Files.Failures["inherit"] = new UnauthorizedAccessException("Attempted to perform an unauthorized operation.");
        Assert.Equal(1, tool.Run("", "apply", ChangePath, "--yes", "--policy", PolicyPath));
        Assert.EndsWith(
            "\n" + R($"The policy file was written at {PolicyPath}, but it could not be given the permissions of its folder: Attempted to perform an unauthorized operation. " +
                     "The runner's user may not be able to read it until an administrator sets them.") + "\n",
            tool.Output);
        Assert.Contains(PolicyPath, tool.Files.Text.Keys);
        Assert.Equal(0, tool.Restarts);
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
                R(@"the backup folder cannot be trusted: PC\bot owns the backup folder; PC\bot can create files or folders in the backup folder; " +
                  "an administrator must check and remove it") + "\n",
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
        Assert.Equal($"{R($"{folder} exists and is not a folder; an administrator must check and remove it")}\n", tool.Output);
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
            Assert.Equal($"{R($"{PolicyPath} is a folder, not a policy file; an administrator must check and remove it")}\n", tool.Output);
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
        Assert.Equal(R(@"the backup folder cannot be trusted: PC\bot owns the backup folder; an administrator must check and remove it") + "\n", tool.Output);
        Assert.Single(tool.Files.Writes);
    }

    [Fact]
    public void A_backup_folder_that_stops_being_trusted_while_the_administrator_reads_is_refused_in_the_same_words()
    {
        // The folder is checked again when the tool writes; the refusal is printed as it is.
        const string refusal = @"the backup folder cannot be trusted: PC\bot owns the backup folder; an administrator must check and remove it";
        var folder = PolicyCommand.BackupFolder(PolicyPath);
        var tool = new Tool();
        tool.AtPrompt = () =>
        {
            tool.Files.Folders.Add(folder);
            tool.Files.BackupProblems[folder] = [@"PC\bot owns the backup folder"];
        };
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{AllowErp}\n{OneApp}\n{Prompt}{R(refusal)}\n", tool.Output);
        Assert.Equal(Starter, tool.Files.Text[PolicyPath]);
        Assert.Equal([PolicyPath, ChangePath], tool.Files.Text.Keys);
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
            tool.AtPrompt = () =>
            {
                if (asFolder) tool.Files.Folders.Add(PolicyPath);
                else tool.Files.Text[PolicyPath] = "planted";
            };
            Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
            Assert.Equal(
                $"Creating a new policy at {PolicyPath}.\n{AllowErp}\n{OneApp}\n{Prompt}{R("a policy file appeared while the change was being applied; nothing was written")}\n",
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
            $"{Changing()}\n{AllowErp}\n{OneApp}\n{R("Policy updated, but the runner could not be restarted: Access is denied. Restart it by hand.")}\n",
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
        Assert.Equal($"Policy file: {PolicyPath}\n{{ \"allowedApps\": [null] }}\n{R($"{PolicyPath}: an entry in allowedApps must be an object")}\n", tool.Output);
    }

    [Theory]
    [MemberData(nameof(OtherConsoles))]
    public void Policy_option_is_refused_unless_every_other_process_in_the_console_is_elevated(bool[]? others, bool takesKeys)
    {
        string[][] commands = [["apply", ChangePath, "--policy", PolicyPath], ["allow-app", ErpPath, "--policy", PolicyPath, "--yes"], ["show", "--policy", PolicyPath]];
        foreach (var command in commands)
        {
            var tool = new Tool { Console = new PolicyConsole(others, takesKeys, () => null) };
            Assert.Equal(1, tool.Run("\n", command));
            Assert.Equal($"--policy needs an administrator console\n{(tool.Console.ClosesWithTheTool ? Closing + "\n" : "")}", tool.Output);
            Assert.Empty(tool.Files.Reads);
            Assert.Empty(tool.Files.Opened);
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
        Assert.Empty(tool.Files.Opened);
        Assert.Empty(tool.Files.Walked);
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
        Assert.Equal($"Policy file: {PolicyPath}\n{{\n  \"allowedApp\": []\n}}\n{R($"{PolicyPath}: unknown key \"allowedApp\"")}\n", tool.Output);

        tool.Files.Text.Remove(PolicyPath);
        Assert.Equal(1, tool.Run("", "show", "--policy", PolicyPath));
        Assert.Equal($"{R($"Policy file not found: {PolicyPath}")}\n", tool.Output);
        Assert.Empty(tool.Files.Writes);
    }

    [Fact]
    public void Everything_printed_shows_control_and_format_characters_as_escapes()
    {
        // A refusal that repeats part of the change, as a literal: a cursor command, a line break, a language tag and
        // an emoji (outside the basic plane, so two escapes each).
        var tool = new Tool();
        tool.Files.Text[ChangePath] = """{ "bad\u001b[1A\nkey\udb40\udc01\ud83d\ude00\u202e": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\n{R("the change: unknown key \"bad\\u001B[1A\\u000Akey\\uDB40\\uDC01\\uD83D\\uDE00\\u202E\"")}\n", tool.Output);

        // The show output keeps the file's own lines and escapes what is inside them; so do a path and a parse error.
        var odd = Path.Combine(Root, "RPA\u0007 Runner", "policy.json");
        // The file holds a tab, a line separator inside a string and (as JSON's own escape) a cursor command.
        tool.Files.Text[odd] = "{\n\t\"gatedKeys\": [\"F1\\u001b[2J\u2028\"]\r\n}\n";
        Assert.Equal(1, tool.Run("", "show", "--policy", odd));
        var shown = odd.Replace("\u0007", "\\u0007");
        Assert.Equal(
            $"Policy file: {shown}\n{{\n\\u0009\"gatedKeys\": [\"F1\\u001b[2J\\u2028\"]\n}}\n{R($"{shown}: gatedKeys has an invalid key chord \"F1\\u001B[2J\\u2028\"")}\n",
            tool.Output);

        Assert.Equal(1, tool.Run("", "show", "--policy", odd + "\u200b"));
        Assert.Equal($"{R($"Policy file not found: {shown}\\u200B")}\n", tool.Output);
    }

    /// <summary>Rows as the tool breaks them: at most 76 characters, every row after the first after eight spaces.
    /// Returns the rows put together again.</summary>
    private static string Joined(IEnumerable<string> rows)
    {
        var list = rows.ToList();
        Assert.All(list, row => Assert.InRange(row.Length, 0, 76));
        Assert.All(list.Skip(1), row => Assert.StartsWith("        ", row));
        return list[0] + string.Concat(list.Skip(1).Select(row => row[8..]));
    }

    [Fact]
    public void A_refusal_is_printed_in_rows_like_the_summary()
    {
        // A key of 200,000 characters: its first 60, in two rows.
        var tool = new Tool();
        tool.Files.Text[ChangePath] = $$"""{ "{{new string('k', 200_000)}}": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\nthe change: unknown key \"{new string('k', 51)}\n        {new string('k', 9)}\"...\n", tool.Output);

        // Words of the tool's in a key land on a row that starts with eight spaces.
        tool.Files.Text[ChangePath] = $$"""{ "{{new string('k', 51)}}Policy updated.": 1 }""";
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal($"{Changing()}\nthe change: unknown key \"{new string('k', 51)}\n        Policy up\"...\n", tool.Output);

        // A path the caller gave is printed whole, in rows.
        var missing = Path.Combine(Root, new string('m', 150), "Policy updated.json");
        Assert.Equal(1, tool.Run("y\n", "apply", missing, "--policy", PolicyPath));
        var rows = tool.Output.TrimEnd('\n').Split('\n');
        Assert.Equal(3, rows.Length);
        Assert.Equal($"Change file not found: {missing}", Joined(rows));
        Assert.Equal(1, tool.Run("y\n", "allow-app", missing, "--pin-hash", "--policy", PolicyPath));
        Assert.Equal($"Application file not found: {missing}", Joined(tool.Output.TrimEnd('\n').Split('\n')));

        // The tool's own long sentences break after a space.
        tool.Files.Untrusted[PolicyPath] = [@"PC\bot owns the policy file", @"BUILTIN\Users can change or replace the policy file's folder"];
        Assert.Equal(1, tool.Run("y\n", "apply", ChangePath, "--policy", PolicyPath));
        Assert.Equal(
            "the existing policy file cannot be trusted: PC\\bot owns the policy file; \n" +
            "        BUILTIN\\Users can change or replace the policy file's folder; an \n" +
            "        administrator must check and replace it\n",
            tool.Output);
    }

    [Fact]
    public void Show_prints_a_long_line_of_the_policy_file_in_rows()
    {
        var path = Path.Combine(Root, new string('d', 120), "ErpDemo.exe");
        var comment = "  // " + new string('x', 71) + "Policy updated. The runner restarts within 10 seconds and uses the new policy.";
        var app = $$"""  "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(path)}} }]""";
        var tool = new Tool();
        tool.Files.Text[PolicyPath] = $"{{\n{comment}\n\n{app}\n}}\n";
        Assert.Equal(0, tool.Run("", "show", "--policy", PolicyPath));
        var rows = tool.Output.TrimEnd('\n').Split('\n');
        Assert.Equal($"Policy file: {PolicyPath}", rows[0]);
        Assert.Equal("{", rows[1]);
        Assert.Equal([comment[..76], "        Policy updated. The runner restarts within 10 seconds and uses the ", "        new policy."], rows[2..5]);
        Assert.Equal("", rows[5]);
        Assert.Equal(app, Joined(rows[6..^1]));
        Assert.InRange(rows.Length - 7, 3, 4);
        Assert.Equal("}", rows[^1]);
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
