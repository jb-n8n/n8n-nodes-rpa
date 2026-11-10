using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Rpa.Runner.Core.Policy;

/// <summary>What has a name in the file system: nothing, a file or a folder.</summary>
public enum PathKind
{
    None,
    File,
    Folder,
}

/// <summary>The files the policy tool touches (the real file system in RpaPolicy.exe, a fake in the tests).</summary>
public interface IPolicyFiles
{
    /// <summary>The file's bytes, or null when there is no such file.</summary>
    byte[]? ReadBytes(string path);

    /// <summary>What is at the path. A link counts as what it is itself, not as what it points to.</summary>
    PathKind Kind(string path);

    /// <summary>What the runner's own start check finds wrong with the policy file and its folder (someone other than
    /// an administrator owns them or can change them); empty when it would pass.</summary>
    IReadOnlyList<string> Problems(string path);

    /// <summary>What is wrong with an existing backup folder: it is a link, or someone other than an administrator
    /// owns it, can change it or can create files or folders in it. Empty when the tool would use it.</summary>
    IReadOnlyList<string> BackupFolderProblems(string folder);

    /// <summary>
    /// Creates a temporary file beside the policy file, with a random name, for administrators only from before its
    /// first byte, writes the content and returns the file's path. Nothing is left when this fails.
    /// </summary>
    string CreateTemporary(string policyPath, byte[] content);

    /// <summary>Creates the backup folder, for administrators only.</summary>
    void CreateBackupFolder(string folder);

    /// <summary>
    /// Creates a backup as a new file with this content (it fails when something has the name), with the owner and
    /// the access rules the backup folder gives. Nothing is left when this fails.
    /// </summary>
    void CreateBackup(string backupPath, byte[] content);

    /// <summary>Puts the temporary file in the place of the policy file in one step; the policy file keeps its
    /// permissions.</summary>
    void Replace(string temporary, string policyPath);

    /// <summary>Moves a file to a name that nothing has; it fails when something has the name.</summary>
    void MoveNew(string from, string to);

    /// <summary>Gives the file the permissions its folder gives to a file created in it.</summary>
    void InheritPermissions(string path);

    /// <summary>Deletes a file; no error when nothing has the name.</summary>
    void Delete(string path);

    /// <summary>
    /// Opens a file whose path the caller chose (a change file, an application to hash), or returns null when nothing
    /// has that name. The open does not follow a link in the last name of the path and asks Windows to let a pipe's
    /// server identify the tool's user, not act as that user; what it found is reported and the tool decides
    /// (<see cref="OpenedFile.Regular"/>).
    /// </summary>
    OpenedFile? Open(string path);

    /// <summary>
    /// The device a drive letter stands for, as Windows names it: <c>\Device\HarddiskVolume3</c> for a volume,
    /// <c>\Device\LanmanRedirector\...</c> for a mapped network drive, <c>\??\C:\folder</c> for a letter that
    /// <c>subst</c> made for a folder. Null when the root is not a drive letter (<c>C:\</c>) or no such letter is
    /// there. Asking does not open the drive.
    /// </summary>
    string? DriveDevice(string root);

    /// <summary>True when Windows gives the drive's type as fixed: not a network, removable or optical drive.</summary>
    bool FixedDrive(string root);

    /// <summary>
    /// True when what has this name is a link (a junction, a symbolic link, a mount point or another reparse point),
    /// read from the name itself without following it, and also when that could not be read. False when it is a
    /// plain file or folder, or when nothing has the name.
    /// </summary>
    bool IsLink(string path);
}

/// <summary>
/// What an open of a caller-chosen path found. The tool reads <paramref name="Content"/> (through the handle that
/// was opened, not by opening the path again) only when the file is <see cref="Regular"/>.
/// </summary>
/// <param name="DiskFile">The handle is a file on a disk, not a pipe, a device or a console.</param>
/// <param name="Folder">It is a folder.</param>
/// <param name="Link">It is a link (a symbolic link or a junction), opened as the link itself.</param>
/// <param name="LocalFixedDrive">The final path of what was opened is on a local fixed drive: not on a network
/// share and not on a removable drive, also not through a link in an earlier part of the path.</param>
/// <param name="Length">Its size in bytes.</param>
public sealed record OpenedFile(bool DiskFile, bool Folder, bool Link, bool LocalFixedDrive, long Length, Stream Content) : IDisposable
{
    public bool Regular => DiskFile && !Folder && !Link && LocalFixedDrive;

    public void Dispose() => Content.Dispose();
}

/// <summary>No policy file existed when the tool checked, and something has its name at the write.</summary>
public sealed class PolicyAppearedException() : IOException("a policy file appeared while the change was being applied; nothing was written");

/// <summary>
/// What the policy tool finds out about the console it runs in (RpaPolicy.exe asks Windows; the tests give values).
/// </summary>
/// <param name="OtherProcesses">One entry for each other process attached to the tool's console: true when that
/// process is elevated, false when it is not or when that could not be read. Null when the tool has no console.</param>
/// <param name="TakesKeys">True when the tool reads its input from a console window on the desktop of a person who is
/// signed in, so that someone can press Enter in it.</param>
public sealed record PolicyConsole(IReadOnlyList<bool>? OtherProcesses, bool TakesKeys)
{
    /// <summary>
    /// <c>--yes</c> and <c>--policy</c> are honoured only when the tool shares its console with at least one other
    /// process and every one of them is elevated. Alone in its console, without one, or beside a process that is not
    /// elevated, the tool may have been given its arguments by a program that is not an administrator's.
    /// </summary>
    public bool HonoursOptions => OtherProcesses is { Count: > 0 } && OtherProcesses.All(elevated => elevated);

    /// <summary>
    /// The tool waits for Enter before it exits only when it is alone in a console someone can type in: that window
    /// closes with the tool. With no console, or one nobody can type in (a scheduled task, a hidden process), there is
    /// no wait: its input may never give a line. This decides nothing else.
    /// </summary>
    public bool ClosesWithTheTool => OtherProcesses is { Count: 0 } && TakesKeys;
}

/// <summary>
/// The policy tool's commands: <c>show</c>, <c>apply</c> and <c>allow-app</c>. A change is shown as plain lines and
/// written only after a yes (or with <c>--yes</c>). Exit codes: 0 applied or nothing to change, 1 refused or invalid,
/// 2 usage, 3 declined at the prompt.
/// </summary>
public static class PolicyCommand
{
    /// <summary>A change file larger than this is refused unread.</summary>
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
    /// Why the backup folder of this policy cannot be used, or null when it can. A folder that is not there yet is
    /// fine: the tool creates it. <see cref="PolicyWrite"/> asks again when it writes.
    /// </summary>
    public static string? BackupFolderRefusal(string policyPath, IPolicyFiles files)
    {
        var folder = BackupFolder(policyPath);
        switch (files.Kind(folder))
        {
            case PathKind.None: return null;
            case PathKind.File: return $"{folder} exists and is not a folder; an administrator must check and remove it";
        }
        var problems = files.BackupFolderProblems(folder);
        return problems.Count == 0 ? null : $"the backup folder cannot be trusted: {string.Join("; ", problems)}; an administrator must check and remove it";
    }

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

    /// <summary>
    /// Writes one line in rows (<see cref="PolicyChange.Rows"/>): everything the tool prints that may repeat text
    /// from a file or from its arguments (a refusal, a failure, a line of the policy file), so that a console does
    /// not break the line and put its rest at the left edge.
    /// </summary>
    public static void PrintRows(TextWriter output, string line)
    {
        foreach (var row in PolicyChange.Rows(Visible(line))) output.WriteLine(row);
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
    /// Runs one command. Whoever starts the tool chooses its arguments, and the Windows administrator prompt shows an
    /// administrator only the tool's name. So <c>--yes</c> is ignored and <c>--policy</c> is refused unless
    /// <paramref name="console"/> says the options can be honoured (<see cref="PolicyConsole.HonoursOptions"/>):
    /// the change to the runner's own policy is then still shown and asked about.
    /// </summary>
    public static int Run(string[] args, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner, PolicyConsole console)
    {
        int code;
        try
        {
            code = Command(args, input, output, files, restartRunner, console.HonoursOptions);
        }
        catch (Exception e)
        {
            // Refusals and anything unforeseen end the same way: the message, no stack trace, exit 1.
            code = Fail(output, e.Message);
        }
        if (console.ClosesWithTheTool)
        {
            // The tool's own window closes when it exits; without this nothing it printed could be read.
            Print(output, "Press Enter to close.");
            input.ReadLine();
        }
        return code;
    }

    private static int Command(string[] args, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner, bool honourOptions)
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
        if (!honourOptions)
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
        PrintRows(output, message);
        return 1;
    }

    private static int Show(string policyPath, TextWriter output, IPolicyFiles files)
    {
        if (ExistingPolicy(policyPath, files) is not { } bytes) return Fail(output, $"Policy file not found: {policyPath}");
        var text = Text(bytes, bytes.Length);
        Print(output, $"Policy file: {policyPath}");
        // The file's own line breaks stay; anything else that is not plain text inside a line is shown as an escape,
        // and a long line is printed in rows.
        foreach (var line in text.TrimEnd('\r', '\n').Split('\n')) PrintRows(output, line.TrimEnd('\r'));
        PolicyChange.Parse(text, policyPath);
        return 0;
    }

    /// <summary>
    /// The policy file's bytes, or null when there is none. A file that is there is used only when the runner's own
    /// start check passes it: a user who is not an administrator may be able to create the file where none exists, and
    /// the tool would otherwise merge that file and write it back as an administrator's.
    /// </summary>
    private static byte[]? ExistingPolicy(string path, IPolicyFiles files)
    {
        var kind = files.Kind(path);
        if (kind == PathKind.Folder)
            throw new RunnerPolicy.InvalidPolicyException($"{path} is a folder, not a policy file; an administrator must check and remove it");
        if (kind == PathKind.None) return null;
        var problems = files.Problems(path);
        if (problems.Count > 0)
            throw new RunnerPolicy.InvalidPolicyException($"the existing policy file cannot be trusted: {string.Join("; ", problems)}; an administrator must check and replace it");
        return files.ReadBytes(path);
    }

    /// <summary>A file's text: UTF-8, unless its first bytes are the byte order mark of another encoding (as the
    /// runner reads its policy file).</summary>
    private static string Text(byte[] bytes, int count)
    {
        using var reader = new StreamReader(new MemoryStream(bytes, 0, count), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// A file whose path the caller chose, opened once, or null when nothing has the name. Whoever started the tool
    /// may not be an administrator, and the tool opens the file elevated. The path is looked at first
    /// (<see cref="RefuseUnlessPlain"/>); then the file is opened and used only when what was opened is a regular
    /// file on a local fixed drive (not a pipe or a device, a folder, a link, or a file on a network share or a
    /// removable drive), which also covers a path that changed between the look and the open. The refusal names the
    /// path as the caller gave it and nothing else.
    /// </summary>
    private static OpenedFile? CallerFile(string path, string given, IPolicyFiles files)
    {
        RefuseUnlessPlain(path, given, files);
        var file = files.Open(path);
        if (file is null || file.Regular) return file;
        file.Dispose();
        throw new RunnerPolicy.InvalidPolicyException($"{given} is not a regular file on a local drive");
    }

    /// <summary>
    /// Refuses a path the caller chose from the path alone, before it is opened or written into the policy. Its
    /// drive must be a letter that is a volume of its own with the drive type "fixed": a mapped network drive, a
    /// removable drive and a letter that <c>subst</c> made for a folder are refused (the letter's device is asked
    /// first, which does not open the drive, and the drive type only for a letter that names a device of its own).
    /// Then each name of the full path is asked about, from the drive downward, and the first one that is a link (a
    /// junction, a symbolic link, a mount point) is refused: an open would follow such a link to wherever it leads,
    /// a network share included, and a policy entry under such a path would name whatever the link points to later.
    /// Nothing is asked about past the first link. The refusal names the path as the caller gave it.
    /// </summary>
    private static void RefuseUnlessPlain(string full, string given, IPolicyFiles files)
    {
        var root = Path.GetPathRoot(full) ?? "";
        var plain = files.DriveDevice(root) is { } device && device.StartsWith(@"\Device\", StringComparison.Ordinal) && files.FixedDrive(root);
        var at = root;
        foreach (var name in full[root.Length..].Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            if (!plain) break;
            // Not Path.Combine: a name with a colon in it would be taken for a path of its own.
            at = Path.Join(at, name);
            plain = !files.IsLink(at);
        }
        if (!plain) throw new RunnerPolicy.InvalidPolicyException($"{given} is not a regular file on a local drive");
    }

    /// <summary>
    /// The change file's text. A UNC or device path is refused on its text, before anything is opened. The size is
    /// checked before the file is read, and no more than the limit is read whatever the size says. The text is read
    /// as UTF-8 unless the file starts with the byte order mark of another encoding.
    /// </summary>
    private static string ChangeFile(string path, IPolicyFiles files)
    {
        var full = RunnerPolicy.IsUncOrDevice(path) ? path : Path.GetFullPath(path);
        if (RunnerPolicy.IsUncOrDevice(full)) throw new RunnerPolicy.InvalidPolicyException("the change file must be on a local drive");
        using var file = CallerFile(full, path, files) ?? throw new FileNotFoundException($"Change file not found: {path}");
        if (file.Length > MaxChangeFileBytes) throw new RunnerPolicy.InvalidPolicyException("the change file is larger than 256 KiB");
        var bytes = new byte[MaxChangeFileBytes + 1];
        var read = file.Content.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
        if (read > MaxChangeFileBytes) throw new RunnerPolicy.InvalidPolicyException("the change file is larger than 256 KiB");
        return Text(bytes, read);
    }

    /// <summary>
    /// The change that allows one application: its file name, its full path and, when asked, its hash. Whoever started
    /// the tool chose the path. A UNC or device path (opening one makes the elevated tool sign in to a server, or read
    /// a device) and a short (8.3) name are refused on the text as given, before the tool resolves or opens the path;
    /// the full path is tested again. With or without a hash, the path must be on a fixed drive of its own and hold
    /// no link (<see cref="RefuseUnlessPlain"/>), so the entry is written under the application's real location.
    /// The hash is taken from a regular file on a local drive (<see cref="CallerFile"/>), read as a stream.
    /// </summary>
    private static string AllowApp(Arguments arguments, IPolicyFiles files)
    {
        var target = arguments.Target!;
        PolicyChange.RefuseShortName(target);
        var path = RunnerPolicy.IsUncOrDevice(target) ? target : Path.GetFullPath(target);
        // The parser's own words for such a path in a change file.
        if (RunnerPolicy.IsUncOrDevice(path))
            throw new RunnerPolicy.InvalidPolicyException("the change: allowedApps[].path must be an absolute local path (no UNC or device paths)");
        var app = new Dictionary<string, string> { ["exe"] = Path.GetFileName(path), ["path"] = path };
        if (arguments.PinHash)
        {
            using var file = CallerFile(path, target, files) ?? throw new FileNotFoundException($"Application file not found: {target}");
            app["sha256"] = Convert.ToHexString(SHA256.HashData(file.Content));
        }
        else
        {
            RefuseUnlessPlain(path, target, files);
        }
        return JsonSerializer.Serialize(new Dictionary<string, object> { ["allowedApps"] = new[] { app } });
    }

    private static int Change(string change, Arguments arguments, TextReader input, TextWriter output, IPolicyFiles files, Action restartRunner)
    {
        var before = ExistingPolicy(arguments.PolicyPath, files);
        var current = before is null ? null : Text(before, before.Length);
        // Only an existing policy is backed up. A backup folder that cannot be used is said now, not after the
        // administrator has read the summary and answered.
        if (current is not null && BackupFolderRefusal(arguments.PolicyPath, files) is { } refusal) return Fail(output, refusal);
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
        var rows = PolicyChange.Printed(result.Summary);
        if (rows.Prepend(Visible(first)).Sum(row => row.Length + 1) > MaxSummaryLength)
            return Fail(output, $"the summary of this change would be longer than {MaxSummaryLength} characters; split it into smaller changes");
        foreach (var row in rows) Print(output, row);
        if (!arguments.Yes)
        {
            Print(output, "Apply these changes? [y/N] ", endLine: false);
            output.Flush();
            if (input.ReadLine()?.Trim().ToLowerInvariant() is not ("y" or "yes")) return 3;
        }
        // A write that fails or is refused ends here with its own message (Run prints it): PolicyWrite says what
        // happened to the policy file, and the runner is not restarted.
        PolicyWrite.Write(files, arguments.PolicyPath, result.Json, before, DateTimeOffset.Now);
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
            PrintRows(output, $"Policy updated, but the runner could not be restarted: {e.Message.TrimEnd('.')}. Restart it by hand.");
            return 0;
        }
        Print(output, "Policy updated. The runner restarts within 10 seconds and uses the new policy.");
        return 0;
    }
}
