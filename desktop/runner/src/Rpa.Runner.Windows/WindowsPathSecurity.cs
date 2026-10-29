using System.Security.AccessControl;
using System.Security.Principal;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Windows;

/// <summary>
/// Private directories with an explicit, non-inherited ACL (the runner's user, SYSTEM and Administrators only), and a
/// check of whether the runner's user could modify or replace a file, from the file's and its directory's ACLs and
/// owners against the user's enabled groups (deny-only groups of a filtered admin token do not count).
/// </summary>
public sealed class WindowsPathSecurity : IPathSecurity
{
    private const FileSystemRights FileWrite = FileSystemRights.WriteData | FileSystemRights.AppendData |
        FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    // On a directory WriteData is "create files" and AppendData "create subfolders"; DeleteSubdirectoriesAndFiles lets
    // a user delete (and so replace) the executable.
    private const FileSystemRights DirWrite = FileSystemRights.CreateFiles | FileSystemRights.CreateDirectories |
        FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    public void CreatePrivateDirectory(string path)
    {
        var acl = PrivateAcl();
        var dir = new DirectoryInfo(path);
        if (!dir.Exists)
        {
            dir.Create(acl);
            return;
        }
        try { dir.SetAccessControl(acl); }
        catch (Exception e) when (e is UnauthorizedAccessException or PrivilegeNotHeldException or InvalidOperationException)
        {
            // An administrator created it for us; their ACL stands.
        }
    }

    private static DirectorySecurity PrivateAcl()
    {
        using var me = WindowsIdentity.GetCurrent();
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[]
                 {
                     me.User!,
                     new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                     new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                 })
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.SetOwner(me.User!);
        return acl;
    }

    public bool IsWritableByRunnerUser(string file)
    {
        using var me = WindowsIdentity.GetCurrent();
        var sids = new HashSet<SecurityIdentifier>(me.Groups?.OfType<SecurityIdentifier>() ?? []) { me.User! };
        sids.Add(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
        sids.Add(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null));
        try
        {
            var fileAcl = new FileInfo(file).GetAccessControl();
            if (Grants(fileAcl, sids, FileWrite, me.User!)) return true;
            var dir = Path.GetDirectoryName(Path.GetFullPath(file));
            return dir is not null && Grants(new DirectoryInfo(dir).GetAccessControl(), sids, DirWrite, me.User!);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or PrivilegeNotHeldException)
        {
            return false; // cannot even read the ACL, so the runner's user cannot change it either
        }
    }

    private static bool Grants(FileSystemSecurity acl, HashSet<SecurityIdentifier> sids, FileSystemRights rights, SecurityIdentifier user)
    {
        // The owner can always rewrite the ACL.
        if (acl.GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner && sids.Contains(owner)) return true;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (rule.FileSystemRights & rights) == 0) continue;
            if (rule.PropagationFlags.HasFlag(PropagationFlags.InheritOnly)) continue;
            if (sids.Contains((SecurityIdentifier)rule.IdentityReference)) return true;
        }
        return false;
    }
}
