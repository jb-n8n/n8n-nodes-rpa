namespace Rpa.Runner.Core.Ui;

/// <summary>File system protections the platform provides: private directories, and whether the runner's own user
/// could replace a file (then it is not really pinned).</summary>
public interface IPathSecurity
{
    /// <summary>Creates the directory so that only the runner's user, SYSTEM and administrators can use it. An existing
    /// directory is left as it is (an administrator may have prepared it).</summary>
    void CreatePrivateDirectory(string path);

    /// <summary>True when the runner's user can modify or replace the file (write it, or write its directory).</summary>
    bool IsWritableByRunnerUser(string file);
}

/// <summary>Non-Windows: directories with mode 0700. The writable check is Windows-only (the runner runs there), so it
/// reports false.</summary>
public sealed class DefaultPathSecurity : IPathSecurity
{
    public void CreatePrivateDirectory(string path)
    {
        if (Directory.Exists(path)) return;
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    public bool IsWritableByRunnerUser(string file) => false;
}
