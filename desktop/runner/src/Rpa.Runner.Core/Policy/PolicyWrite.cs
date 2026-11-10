using System.Text;

namespace Rpa.Runner.Core.Policy;

/// <summary>A write of the policy file that failed. The message says what happened and where the old policy is.</summary>
public sealed class PolicyWriteException(string message) : IOException(message);

/// <summary>
/// Writes the policy file: the order of the steps (<see cref="IPolicyFiles"/> does each one) and what is done when a
/// step fails. The new text goes into a temporary file beside the policy and is put in place in one step. An existing
/// policy is first copied to the backup folder, and is replaced only while it still holds what the tool read at its
/// start. The tool does not delete a backup copy it has made. After a swap that failed it looks at what is under the
/// policy's name before it removes anything: the temporary file is removed only when a policy file is there, and
/// when none is, the old policy is moved back from its backup copy first.
/// </summary>
public static class PolicyWrite
{
    private const string Changed = "the policy file changed while this change was being applied; nothing was written";
    private const string Untouched = "The runner keeps running with the policy it has.";

    /// <summary>
    /// Writes <paramref name="json"/> as the policy file. <paramref name="before"/> is what the policy file held when
    /// the tool read it at its start, or null when there was none. Throws <see cref="PolicyWriteException"/> for a
    /// write that failed, and <see cref="PolicyAppearedException"/> or
    /// <see cref="RunnerPolicy.InvalidPolicyException"/> for a write that was refused with nothing written.
    /// </summary>
    public static void Write(IPolicyFiles files, string path, string json, byte[]? before, DateTimeOffset now)
    {
        var content = Encoding.UTF8.GetBytes(json);
        if (before is null) WriteNew(files, path, content);
        else Replace(files, path, content, before, now);
    }

    /// <summary>
    /// No policy file was there at the start: the new one is moved in only when nothing has its name by now (a file
    /// that appeared may be anyone's), and then takes the permissions of its folder.
    /// </summary>
    private static void WriteNew(IPolicyFiles files, string path, byte[] content)
    {
        string temporary;
        try
        {
            temporary = files.CreateTemporary(path, content);
        }
        catch (Exception e)
        {
            throw Failed(e, "No policy file was written.");
        }
        try
        {
            files.MoveNew(temporary, path);
        }
        catch (Exception e)
        {
            var appeared = e is IOException or UnauthorizedAccessException && files.Kind(path) != PathKind.None;
            var left = Remove(files, temporary);
            if (appeared) throw new PolicyAppearedException();
            throw Failed(e, "No policy file was written." + left);
        }
        try
        {
            files.InheritPermissions(path);
        }
        catch (Exception e)
        {
            throw new PolicyWriteException(
                $"The policy file was written at {path}, but it could not be given the permissions of its folder: {Message(e)}. " +
                "The runner's user may not be able to read it until an administrator sets them.");
        }
    }

    private static void Replace(IPolicyFiles files, string path, byte[] content, byte[] before, DateTimeOffset now)
    {
        string? temporary = null;
        string backup;
        try
        {
            // Time has passed since the tool read the policy (the administrator read the summary). The change that
            // was shown was made from that text, so a file that holds anything else by now is not replaced.
            if (!Same(files.ReadBytes(path), before)) throw new RunnerPolicy.InvalidPolicyException(Changed);
            temporary = files.CreateTemporary(path, content);
            backup = Backup(files, path, before, now);
            // Directly before the swap: the policy file and its backup copy hold the same bytes.
            if (!Same(files.ReadBytes(path), files.ReadBytes(backup))) throw new RunnerPolicy.InvalidPolicyException(Changed);
        }
        catch (Exception e)
        {
            // Nothing has touched the policy file. A backup copy that was made stays.
            var left = temporary is null ? "" : Remove(files, temporary);
            if (e is RunnerPolicy.InvalidPolicyException) throw;
            throw Failed(e, Untouched + left);
        }
        try
        {
            files.Replace(temporary, path);
        }
        catch (Exception e)
        {
            throw AfterFailedSwap(files, path, temporary, backup, before, e);
        }
    }

    /// <summary>
    /// Writes the old policy into the backup folder under a free name and returns that name. The tool creates the
    /// folder when it is missing; a folder that is already there is used only when
    /// <see cref="PolicyCommand.BackupFolderRefusal"/> has nothing against it, asked again here because time has
    /// passed since the start.
    /// </summary>
    private static string Backup(IPolicyFiles files, string path, byte[] before, DateTimeOffset now)
    {
        var folder = PolicyCommand.BackupFolder(path);
        if (files.Kind(folder) == PathKind.None) files.CreateBackupFolder(folder);
        if (PolicyCommand.BackupFolderRefusal(path, files) is { } refusal) throw new RunnerPolicy.InvalidPolicyException(refusal);
        var backup = PolicyCommand.BackupPath(path, now, name => files.Kind(name) != PathKind.None);
        files.CreateBackup(backup, before);
        return backup;
    }

    /// <summary>
    /// What the tool does and says after a swap that failed, decided by looking. Windows documents failures of the
    /// replace after which the replaced file no longer exists and the replacement still has its own name.
    /// <list type="bullet">
    /// <item>A policy file is there: the temporary file is removed. The message says the runner keeps its policy
    /// only when the file still holds the old bytes; otherwise it says where the copy of the old policy is.</item>
    /// <item>No policy file is there: the old policy is moved back from its backup copy (a move that fails when
    /// something has the name by now) and takes the permissions of its folder; then the temporary file is removed.
    /// When the move fails, both files stay and the message says where they are.</item>
    /// </list>
    /// </summary>
    private static PolicyWriteException AfterFailedSwap(IPolicyFiles files, string path, string temporary, string backup, byte[] before, Exception swap)
    {
        if (files.Kind(path) == PathKind.File)
        {
            bool unchanged;
            try
            {
                unchanged = Same(files.ReadBytes(path), before);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                unchanged = false;
            }
            var rest = unchanged
                ? Untouched
                : $"The policy file at {path} is still there, but the tool could not confirm that it is unchanged; look at it. A copy of the old policy is at {backup}.";
            return Failed(swap, rest + Remove(files, temporary));
        }

        var back = $"After the failed swap there was no policy file at {path}; the tool put the old policy back there from its backup copy, ";
        var moved = false;
        try
        {
            files.MoveNew(backup, path);
            moved = true;
            files.InheritPermissions(path);
        }
        catch (Exception e) when (!moved)
        {
            return Failed(swap,
                $"After the failed swap there is no policy file at {path}, and putting the old policy back failed: {Message(e)}. " +
                $"The old policy is at {backup}. The changed policy, which was not applied, is at {temporary}. " +
                $"An administrator must put the old policy back at {path}: the runner reads it when it starts.");
        }
        catch (Exception e)
        {
            return Failed(swap,
                $"{back}but could not give it the permissions of its folder: {Message(e)}. " +
                "The runner's user may not be able to read it until an administrator sets them." + Remove(files, temporary));
        }
        var problems = files.Problems(path);
        return Failed(swap,
            $"{back}with the permissions its folder gives." +
            (problems.Count == 0 ? "" : $" The runner will not start with it: {string.Join("; ", problems)}.") + Remove(files, temporary));
    }

    private static bool Same(byte[]? one, byte[]? other) => one is not null && other is not null && one.AsSpan().SequenceEqual(other);

    private static string Message(Exception e) => e.Message.TrimEnd('.');

    private static PolicyWriteException Failed(Exception e, string rest) => new($"Writing the policy failed: {Message(e)}. {rest}");

    /// <summary>Deletes the temporary file; returns nothing to add to a message, or a sentence that names the file
    /// when it could not be deleted.</summary>
    private static string Remove(IPolicyFiles files, string temporary)
    {
        try
        {
            files.Delete(temporary);
            return "";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return $" The temporary file {temporary} could not be removed: {Message(e)}.";
        }
    }
}
