using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
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
    PolicyCommand.PrintRows(Console.Out, e.Message);
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
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const uint GenericRead = 0x80000000;
    private const uint OpenExisting = 3;
    private const uint DriveTypeFixed = 3;
    private const uint InvalidFileAttributes = 0xFFFFFFFF;
    private const uint FileAttributeReparsePoint = 0x400;

    // FILE_FLAG_OPEN_REPARSE_POINT (a link is opened as itself), FILE_FLAG_BACKUP_SEMANTICS (a folder can be opened,
    // and is then refused for what it is), SECURITY_SQOS_PRESENT with SECURITY_IDENTIFICATION.
    private const uint OpenFlags = 0x00200000 | 0x02000000 | 0x00100000 | 0x00010000;

    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    public byte[]? ReadBytes(string path)
    {
        try
        {
            return File.ReadAllBytes(path);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public PathKind Kind(string path) => Directory.Exists(path) ? PathKind.Folder : File.Exists(path) ? PathKind.File : PathKind.None;

    /// <summary>
    /// Opens a file whose path the caller chose, and says what the handle is before anything is read. The caller may
    /// not be an administrator, and this open runs elevated. So the open asks for identification only (a pipe's
    /// server can learn who opened it but cannot act as that user), a link in the last name of the path is opened as
    /// the link and not followed, and the final path of what was opened is asked from the handle, which shows a
    /// network share reached through a link earlier in the path (the open has reached the share by then; nothing is
    /// read from it). The content is read through this same handle.
    /// </summary>
    public OpenedFile? Open(string path)
    {
        var full = Path.GetFullPath(path);
        var handle = CreateFile(full.Length < 260 ? full : @"\\?\" + full, GenericRead, (uint)FileShare.Read, 0, OpenExisting, OpenFlags, 0);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            if (error is ErrorFileNotFound or ErrorPathNotFound) return null;
            throw new IOException($"{path}: {new Win32Exception(error).Message}");
        }
        var diskFile = GetFileType(handle) == FileTypeDisk;
        var attributes = diskFile ? File.GetAttributes(handle) : default;
        var found = new OpenedFile(diskFile, attributes.HasFlag(FileAttributes.Directory), attributes.HasFlag(FileAttributes.ReparsePoint),
            diskFile && OnLocalFixedDrive(handle), 0, Stream.Null);
        if (!found.Regular)
        {
            handle.Dispose();
            return found;
        }
        var content = new FileStream(handle, FileAccess.Read);
        return found with { Length = content.Length, Content = content };
    }

    /// <summary>True when the handle's final path is on a drive letter whose drive is a fixed local one: not a
    /// network share (a path that starts with \\?\UNC\) and not a network, removable or optical drive.</summary>
    private static bool OnLocalFixedDrive(SafeFileHandle file)
    {
        var buffer = new char[512];
        var length = GetFinalPathNameByHandle(file, buffer, (uint)buffer.Length, 0);
        if (length > buffer.Length)
        {
            buffer = new char[length];
            length = GetFinalPathNameByHandle(file, buffer, (uint)buffer.Length, 0);
        }
        if (length == 0 || length > buffer.Length) return false;
        var final = new string(buffer, 0, (int)length);
        return final.Length > 6 && final.StartsWith(@"\\?\", StringComparison.Ordinal) && char.IsAsciiLetter(final[4]) && final[5] == ':' && final[6] == '\\' &&
               new DriveInfo(final.Substring(4, 3)).DriveType == DriveType.Fixed;
    }

    public string? DriveDevice(string root)
    {
        if (root.Length != 3 || !char.IsAsciiLetter(root[0]) || root[1] != ':' || root[2] != '\\') return null;
        var device = new char[1024];
        // The answer is a list of names, each ended by a null; the first is the one in use.
        return QueryDosDevice(root[..2], device, (uint)device.Length) == 0 ? null : new string(device, 0, Math.Max(0, Array.IndexOf(device, '\0')));
    }

    public bool FixedDrive(string root) => GetDriveType(root) == DriveTypeFixed;

    public bool IsLink(string path)
    {
        var attributes = GetFileAttributes(path.Length < 260 ? path : @"\\?\" + path);
        if (attributes == InvalidFileAttributes) return Marshal.GetLastPInvokeError() is not (ErrorFileNotFound or ErrorPathNotFound);
        return (attributes & FileAttributeReparsePoint) != 0;
    }

    public IReadOnlyList<string> Problems(string path) => PolicyFileCheck.Problems(path);

    /// <summary>A link (a junction, for one) is refused whatever it points to: the old policy would be copied into
    /// its target.</summary>
    public IReadOnlyList<string> BackupFolderProblems(string folder) =>
        new DirectoryInfo(folder).Attributes.HasFlag(FileAttributes.ReparsePoint)
            ? ["the backup folder is a link to another folder"]
            : PolicyFileCheck.FolderProblems(folder, "the backup folder");

    /// <summary>
    /// The runner's own user may be able to create files in the policy's folder, so the temporary file has a random
    /// name, is created only when nothing has that name (an existing file or link is an error), and belongs to
    /// administrators only from before its first byte.
    /// </summary>
    public string CreateTemporary(string policyPath, byte[] content)
    {
        var temporary = new FileInfo($"{policyPath}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}.tmp");
        WriteNew(temporary, content);
        return temporary.FullName;
    }

    public void CreateBackupFolder(string folder) =>
        new DirectoryInfo(folder).Create(AdministratorsOnly(new DirectorySecurity(), InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit));

    /// <summary>
    /// The backup is a new file, created for administrators only like the temporary file; once written, its owner is
    /// Administrators and its access rules are the ones it inherits from the backup folder. It does not carry the
    /// policy file's rule that lets the runner's user read it.
    /// </summary>
    public void CreateBackup(string backupPath, byte[] content)
    {
        var backup = new FileInfo(backupPath);
        WriteNew(backup, content);
        try
        {
            var inherited = new FileSecurity();
            inherited.SetOwner(Administrators);
            inherited.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
            backup.SetAccessControl(inherited);
        }
        catch
        {
            backup.Delete();
            throw;
        }
    }

    /// <summary>File.Replace keeps the replaced file's permissions.</summary>
    public void Replace(string temporary, string policyPath) => File.Replace(temporary, policyPath, null);

    public void MoveNew(string from, string to) => File.Move(from, to, overwrite: false);

    /// <summary>The file's own rules stay and the folder's inheritable ones are added, as for a file created there
    /// by hand; with a temporary file's rules alone, the runner's user could not read a new policy.</summary>
    public void InheritPermissions(string path)
    {
        var file = new FileInfo(path);
        var security = file.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
        file.SetAccessControl(security);
    }

    public void Delete(string path) => File.Delete(path);

    /// <summary>A new file for administrators only, written through the handle that created it and flushed; deleted
    /// again when the write fails.</summary>
    private static void WriteNew(FileInfo file, byte[] content)
    {
        var created = false;
        try
        {
            using var stream = file.Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, AdministratorsOnly(new FileSecurity(), InheritanceFlags.None));
            created = true;
            stream.Write(content);
            stream.Flush(flushToDisk: true);
        }
        catch
        {
            if (created) file.Delete();
            throw;
        }
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

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, nint security, uint creation, uint flags, nint template);

    [DllImport("kernel32.dll")]
    private static extern int GetFileType(SafeFileHandle file);

    [DllImport("kernel32.dll", EntryPoint = "QueryDosDeviceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDevice(string device, [Out] char[] target, uint length);

    [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveType(string root);

    [DllImport("kernel32.dll", EntryPoint = "GetFileAttributesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributes(string name);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, [Out] char[] path, uint length, uint flags);

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
