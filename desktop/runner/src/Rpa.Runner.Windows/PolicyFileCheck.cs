using System.Security.AccessControl;
using System.Security.Principal;

namespace Rpa.Runner.Windows;

/// <summary>
/// The policy file must be writable by administrators only (it is the floor n8n cannot lower). Reports access rules
/// that let anyone else change it, or the runner's own user when that user is not an administrator.
/// </summary>
public static class PolicyFileCheck
{
    private const FileSystemRights WriteRights = FileSystemRights.WriteData | FileSystemRights.AppendData |
        FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete |
        FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    private static readonly HashSet<string> Trusted =
    [
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value,
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value,
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // NT SERVICE\TrustedInstaller
    ];

    public static IReadOnlyList<string> Problems(string path)
    {
        var problems = new List<string>();
        FileSecurity acl;
        try { acl = new FileInfo(path).GetAccessControl(); }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or PrivilegeNotHeldException)
        {
            return [$"cannot read the policy file's permissions ({e.GetType().Name})"];
        }
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (rule.FileSystemRights & WriteRights) == 0) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (Trusted.Contains(sid.Value)) continue;
            string name;
            try { name = sid.Translate(typeof(NTAccount)).Value; }
            catch (IdentityNotMappedException) { name = sid.Value; }
            if (IsAdministrator(sid)) continue;
            problems.Add($"{name} can change the policy file");
        }
        return problems;
    }

    private static bool IsAdministrator(SecurityIdentifier sid)
    {
        // The owner of an elevated admin's file shows up as that user; accept it when it is the current, elevated user.
        using var me = WindowsIdentity.GetCurrent();
        return me.User == sid && new WindowsPrincipal(me).IsInRole(WindowsBuiltInRole.Administrator);
    }
}
