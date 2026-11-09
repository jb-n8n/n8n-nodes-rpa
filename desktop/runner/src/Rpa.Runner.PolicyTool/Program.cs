using System.Diagnostics;
using Rpa.Runner.Core.Policy;

// RPA policy tool: shows a change to the runner's policy file in plain lines, asks, and applies it. Everything it
// decides is in PolicyCommand; this file gives it the real files and the runner's restart.
return PolicyCommand.Run(args, Console.In, Console.Out, new PolicyFiles(), PolicyFiles.RestartRunner);

internal sealed class PolicyFiles : IPolicyFiles
{
    public string? Read(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    /// <summary>Writes a temporary file beside the policy, then swaps it in with File.Replace: the policy file keeps
    /// its permissions and is never half written, and the old text stays as the backup.</summary>
    public void WriteWithBackup(string path, string json, DateTimeOffset now)
    {
        var temporary = path + ".new";
        try
        {
            File.WriteAllText(temporary, json);
            if (File.Exists(path)) File.Replace(temporary, path, PolicyCommand.BackupPath(path, now, File.Exists));
            else File.Move(temporary, path);
        }
        finally
        {
            File.Delete(temporary); // still there only when the swap failed
        }
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
