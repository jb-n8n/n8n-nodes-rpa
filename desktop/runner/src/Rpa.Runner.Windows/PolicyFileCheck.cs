using System.Security.AccessControl;
using System.Security.Principal;

namespace Rpa.Runner.Windows;

/// <summary>
/// The policy file must be changeable by administrators only (it is the floor n8n cannot lower). Problems: an owner
/// that is not an administrator (owners can rewrite the ACL), an access rule letting anyone else write, delete or
/// re-permission the file, or one letting them delete or replace files in its folder. The runner refuses to start when
/// there are any.
/// </summary>
public static class PolicyFileCheck
{
    private const FileSystemRights FileRights = FileSystemRights.WriteData | FileSystemRights.AppendData |
        FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    private const FileSystemRights FolderRights = FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Delete |
        FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    private const FileSystemRights CreateRights = FileSystemRights.CreateFiles | FileSystemRights.CreateDirectories;

    public static IReadOnlyList<string> Problems(string path)
    {
        var trusted = Trusted();
        var problems = new List<string>();
        try
        {
            Check(new FileInfo(path).GetAccessControl(), FileRights, "the policy file", trusted, problems);
            var folder = Path.GetDirectoryName(Path.GetFullPath(path));
            if (folder is not null) Check(new DirectoryInfo(folder).GetAccessControl(), FolderRights, "the policy file's folder", trusted, problems);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or PrivilegeNotHeldException)
        {
            problems.Add($"cannot read the permissions of the policy file or its folder ({e.GetType().Name})");
        }
        return problems;
    }

    /// <summary>
    /// The policy tool's test of its backup folder, which administrators alone must be able to change or fill: the
    /// folder test of <see cref="Problems"/>, and also a rule that lets anyone else create files or folders in it
    /// (the runner's start check does not look at that right, and the policy's own folder may grant it).
    /// <paramref name="what"/> names the folder in the problems.
    /// </summary>
    public static IReadOnlyList<string> FolderProblems(string folder, string what)
    {
        var problems = new List<string>();
        try
        {
            var acl = new DirectoryInfo(folder).GetAccessControl();
            var trusted = Trusted();
            Check(acl, FolderRights, what, trusted, problems);
            foreach (var sid in Others(acl, CreateRights, trusted)) problems.Add($"{Name(sid)} can create files or folders in {what}");
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or PrivilegeNotHeldException)
        {
            problems.Add($"cannot read the permissions of {what} ({e.GetType().Name})");
        }
        return problems;
    }

    private static void Check(FileSystemSecurity acl, FileSystemRights rights, string what, HashSet<SecurityIdentifier> trusted, List<string> problems)
    {
        if (acl.GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner && !trusted.Contains(owner))
            problems.Add($"{Name(owner)} owns {what}");
        foreach (var sid in Others(acl, rights, trusted)) problems.Add($"{Name(sid)} can change or replace {what}");
    }

    /// <summary>Whoever an allow rule that applies to the object itself gives any of the rights, the trusted left out
    /// (one entry for each such rule).</summary>
    private static IEnumerable<SecurityIdentifier> Others(FileSystemSecurity acl, FileSystemRights rights, HashSet<SecurityIdentifier> trusted)
    {
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (rule.FileSystemRights & rights) == 0) continue;
            if (rule.PropagationFlags.HasFlag(PropagationFlags.InheritOnly)) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (!trusted.Contains(sid)) yield return sid;
        }
    }

    /// <summary>Administrators, SYSTEM, TrustedInstaller, and the runner's own user only when it runs elevated as an
    /// administrator (then it is an administrator).</summary>
    private static HashSet<SecurityIdentifier> Trusted()
    {
        var set = new HashSet<SecurityIdentifier>
        {
            new(WellKnownSidType.BuiltinAdministratorsSid, null),
            new(WellKnownSidType.LocalSystemSid, null),
            new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), // NT SERVICE\TrustedInstaller
        };
        using var me = WindowsIdentity.GetCurrent();
        if (me.User is not null && new WindowsPrincipal(me).IsInRole(WindowsBuiltInRole.Administrator)) set.Add(me.User);
        return set;
    }

    private static string Name(SecurityIdentifier sid)
    {
        try { return sid.Translate(typeof(NTAccount)).Value; }
        catch (IdentityNotMappedException) { return sid.Value; }
    }
}
