using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Windows;

// RPA policy tool: shows a change to the runner's policy file in plain lines, asks, and applies it. Everything it
// decides is in PolicyCommand; this file gives it the real files, the console question and the runner's restart.
return PolicyCommand.Run(args, Console.In, Console.Out, new PolicyFiles(), PolicyFiles.RestartRunner, PolicyFiles.StartedFromExistingConsole());

internal sealed class PolicyFiles : IPolicyFiles
{
    public string? Read(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    public long? Length(string path) => new FileInfo(path) is { Exists: true } file ? file.Length : null;

    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    public IReadOnlyList<string> Problems(string path) => PolicyFileCheck.Problems(path);

    /// <summary>
    /// Writes a temporary file beside the policy, then swaps it in with File.Replace in one step; the old file goes to
    /// the backup folder. The runner's own user may be able to create files in the policy's folder, so the temporary
    /// file has a random name, is refused when the name exists (never followed or reused), and belongs to
    /// administrators only from before its first byte.
    /// </summary>
    public void WriteWithBackup(string path, string json, DateTimeOffset now)
    {
        var backup = File.Exists(path) ? BackupName(path, now) : null;
        var temporary = new FileInfo($"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}.tmp");
        var created = false;
        try
        {
            using (var stream = temporary.Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, AdministratorsOnly(new FileSecurity(), InheritanceFlags.None)))
            {
                created = true;
                stream.Write(Encoding.UTF8.GetBytes(json));
                stream.Flush(flushToDisk: true);
            }
            if (backup is not null)
            {
                File.Replace(temporary.FullName, path, backup);
            }
            else
            {
                File.Move(temporary.FullName, path);
                InheritFromFolder(path);
            }
        }
        finally
        {
            if (created) File.Delete(temporary.FullName); // still there only when the swap failed
        }
    }

    /// <summary>
    /// A free name in the backup folder. The tool creates the folder for administrators only; a folder that is already
    /// there is used only when it is a real folder that administrators alone can change (the test the runner's start
    /// check uses for the policy's folder).
    /// </summary>
    private static string BackupName(string path, DateTimeOffset now)
    {
        var folder = new DirectoryInfo(PolicyCommand.BackupFolder(path));
        if (!folder.Exists) folder.Create(AdministratorsOnly(new DirectorySecurity(), InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit));
        folder.Refresh();
        var problems = folder.Attributes.HasFlag(FileAttributes.ReparsePoint)
            ? ["the backup folder is a link to another folder"]
            : PolicyFileCheck.FolderProblems(folder.FullName, "the backup folder");
        if (problems.Count > 0) throw new IOException($"the backup folder cannot be trusted: {string.Join("; ", problems)}");
        return PolicyCommand.BackupPath(path, now, name => File.Exists(name) || Directory.Exists(name));
    }

    /// <summary>Owner Administrators; full control for Administrators and SYSTEM; nothing inherited from the folder.</summary>
    private static T AdministratorsOnly<T>(T security, InheritanceFlags inherit) where T : FileSystemSecurity
    {
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(administrators);
        foreach (var sid in new[] { administrators, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
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

    /// <summary>
    /// True when another process shares this console: the tool was started from a console that was already there, and
    /// only an elevated console can start it without the administrator prompt. Alone in its console, or without one,
    /// it was started through that prompt by a program that is not elevated.
    /// </summary>
    public static bool StartedFromExistingConsole() => GetConsoleProcessList(new uint[2], 2) >= 2;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

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
