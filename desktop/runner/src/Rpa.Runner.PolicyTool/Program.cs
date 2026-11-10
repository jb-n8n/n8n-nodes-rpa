using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Windows;

// RPA policy tool: shows a change to the runner's policy file in plain lines, asks, and applies it. Everything it
// decides is in PolicyCommand; this file gives it the real files, what Windows says about the console (WindowsConsole)
// and the runner's restart.
var console = new PolicyConsole(null, TakesKeys: false);
try
{
    console = WindowsConsole.Ask();
    return PolicyCommand.Run(args, Console.In, Console.Out, new PolicyFiles(), PolicyFiles.RestartRunner, console);
}
catch (Exception e)
{
    // The last resort (PolicyCommand.Run handles its own failures): the message, no stack trace.
    PolicyCommand.Print(Console.Out, e.Message);
    if (console.ClosesWithTheTool)
    {
        PolicyCommand.Print(Console.Out, "Press Enter to close.");
        Console.In.ReadLine();
    }
    return 1;
}

internal sealed class PolicyFiles : IPolicyFiles
{
    private const int FileTypeDisk = 1;

    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    public string? Read(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    public long? Length(string path) => new FileInfo(path) is { Exists: true } file ? file.Length : null;

    public PathKind Kind(string path) => Directory.Exists(path) ? PathKind.Folder : File.Exists(path) ? PathKind.File : PathKind.None;

    /// <summary>The file as a stream. What was opened must be a file on a disk: a name can also open a device.</summary>
    public Stream OpenRead(string path)
    {
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (GetFileType(stream.SafeFileHandle) == FileTypeDisk) return stream;
        stream.Dispose();
        throw new IOException($"{path} is not a regular file");
    }

    public IReadOnlyList<string> Problems(string path) => PolicyFileCheck.Problems(path);

    /// <summary>A link (a junction, for one) is refused whatever it points to: the old policy would be copied into
    /// its target.</summary>
    public IReadOnlyList<string> BackupFolderProblems(string folder) =>
        new DirectoryInfo(folder).Attributes.HasFlag(FileAttributes.ReparsePoint)
            ? ["the backup folder is a link to another folder"]
            : PolicyFileCheck.FolderProblems(folder, "the backup folder");

    /// <summary>
    /// Writes a temporary file beside the policy and moves it into place in one step. The runner's own user may be
    /// able to create files in the policy's folder, so the temporary file has a random name, is created only when
    /// nothing has that name (an existing file or link is an error), and belongs to administrators only from before
    /// its first byte. A policy that was there at the start check is first copied to the backup folder and then
    /// replaced (File.Replace keeps its permissions). A new policy is moved in only when nothing has its name.
    /// </summary>
    public void WriteWithBackup(string path, string json, DateTimeOffset now, bool existed)
    {
        var temporary = new FileInfo($"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}.tmp");
        string? backup = null;
        var created = false;
        var written = false;
        try
        {
            using (var stream = temporary.Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, AdministratorsOnly(new FileSecurity(), InheritanceFlags.None)))
            {
                created = true;
                stream.Write(Encoding.UTF8.GetBytes(json));
                stream.Flush(flushToDisk: true);
            }
            if (existed)
            {
                backup = Backup(path, now);
                File.Replace(temporary.FullName, path, null);
            }
            else
            {
                try
                {
                    File.Move(temporary.FullName, path, overwrite: false);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException && Kind(path) != PathKind.None)
                {
                    throw new PolicyAppearedException();
                }
                InheritFromFolder(path);
            }
            written = true;
        }
        finally
        {
            if (created) File.Delete(temporary.FullName); // still there only when the policy was not written
            if (backup is not null && !written) File.Delete(backup);
        }
    }

    /// <summary>
    /// Copies the policy into the backup folder under a free name and returns that name. The tool creates the folder
    /// for administrators only; a folder that is already there is used only when PolicyCommand.BackupFolderRefusal
    /// has nothing against it, asked again here because time has passed since the start. The copy is a new file:
    /// its owner is Administrators and its access rules are the ones it inherits from the backup folder, so it does
    /// not carry the policy file's rule that lets the runner's user read it.
    /// </summary>
    private string Backup(string path, DateTimeOffset now)
    {
        var folder = new DirectoryInfo(PolicyCommand.BackupFolder(path));
        if (Kind(folder.FullName) == PathKind.None) folder.Create(AdministratorsOnly(new DirectorySecurity(), InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit));
        if (PolicyCommand.BackupFolderRefusal(path, this) is { } refusal) throw new RunnerPolicy.InvalidPolicyException(refusal);
        var backup = new FileInfo(PolicyCommand.BackupPath(path, now, name => Kind(name) != PathKind.None));
        var security = new FileSecurity();
        security.SetOwner(Administrators);
        using var copy = backup.Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security);
        using var policy = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        policy.CopyTo(copy);
        copy.Flush(flushToDisk: true);
        return backup.FullName;
    }

    /// <summary>Owner Administrators; full control for Administrators and SYSTEM; nothing inherited from the folder.</summary>
    private static T AdministratorsOnly<T>(T security, InheritanceFlags inherit) where T : FileSystemSecurity
    {
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(Administrators);
        foreach (var sid in new[] { Administrators, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    /// <summary>A policy file that did not exist before takes its folder's permissions again, as one created there by
    /// hand does; with the temporary file's own, the runner's user could not read it.</summary>
    private static void InheritFromFolder(string path)
    {
        var file = new FileInfo(path);
        var security = file.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
        file.SetAccessControl(security);
    }

    [DllImport("kernel32.dll")]
    private static extern int GetFileType(SafeFileHandle file);

    /// <summary>Ends the running runner, which reads the policy only at start. Its start script starts it again.</summary>
    public static void RestartRunner()
    {
        foreach (var runner in Process.GetProcessesByName("RpaRunner"))
        {
            using (runner)
            {
                try { runner.Kill(); }
                catch (InvalidOperationException) { } // it has already exited
            }
        }
    }
}
