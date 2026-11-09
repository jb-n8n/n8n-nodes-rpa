using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Windows;

// RPA policy tool: shows a change to the runner's policy file in plain lines, asks, and applies it. Everything it
// decides is in PolicyCommand; this file gives it the real files and the runner's restart.
return PolicyCommand.Run(args, Console.In, Console.Out, new PolicyFiles(), PolicyFiles.RestartRunner);

internal sealed class PolicyFiles : IPolicyFiles
{
    public string? Read(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    public long? Length(string path) => new FileInfo(path) is { Exists: true } file ? file.Length : null;

    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    /// <summary>
    /// Writes a temporary file beside the policy, then swaps it in: the policy file is never half written, File.Replace
    /// keeps its permissions, and the old text stays as the backup. The runner's own user may be able to create files
    /// in that folder, so the temporary file has a random name, is refused when the name exists (never followed or
    /// reused), and belongs to administrators only from before its first byte.
    /// </summary>
    public void WriteWithBackup(string path, string json, DateTimeOffset now)
    {
        var temporary = new FileInfo($"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}.tmp");
        var created = false;
        try
        {
            using (var stream = temporary.Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, AdministratorsOnly()))
            {
                created = true;
                stream.Write(Encoding.UTF8.GetBytes(json));
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(path))
            {
                File.Replace(temporary.FullName, path, PolicyCommand.BackupPath(path, now, File.Exists));
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

        var problems = PolicyFileCheck.Problems(path);
        if (problems.Count > 0)
        {
            throw new IOException($"The policy file was written, but the runner will not start with it: {string.Join("; ", problems)}. " +
                                  "The policy file and its folder must be changeable by administrators only.");
        }
    }

    /// <summary>Owner Administrators; full control for Administrators and SYSTEM; nothing inherited from the folder.</summary>
    private static FileSecurity AdministratorsOnly()
    {
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(administrators);
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
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
