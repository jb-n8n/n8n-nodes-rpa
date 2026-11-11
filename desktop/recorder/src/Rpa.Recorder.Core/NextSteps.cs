namespace Rpa.Recorder.Core;

/// <summary>Where allowing the recorded app stands: not done yet, the policy tool is open, or it reported success.</summary>
public enum AllowState { NotDone, Waiting, Allowed }

/// <summary>One numbered line of what to do after saving: its title, a sentence under it, its button (null for none)
/// and a command to copy (null for none).</summary>
public sealed record NextLine(string Title, string Detail, string? Button, string? Command, bool ButtonEnabled);

/// <summary>What the policy tool's exit code means for the bar: whether the app is allowed now, and a notice (null for
/// none).</summary>
public sealed record AllowOutcome(bool Allowed, string? Notice, NoticeTone Tone);

/// <summary>
/// What the bar says after saving. 1: allow the recorded app on this machine. The bar starts the policy tool of the
/// install it belongs to (<c>RpaPolicy.exe apply</c> on the saved change file, as administrator, in its own window,
/// where the tool shows what it allows and asks); the recorder itself changes no policy. 2: import the recording in n8n.
/// </summary>
public static class NextSteps
{
    public const string PolicyToolFile = "RpaPolicy.exe";
    public const string AllowButton = "Allow this app…";
    public const string ShowFile = "Show the file";
    public const string Cancelled = "The administrator prompt was cancelled, so the policy tool did not start.";

    /// <summary>The tool's option that closes its own window after a successful apply, without waiting for Enter (after
    /// a refusal or an error it still waits, so that the person can read why).</summary>
    public const string CloseOnSuccess = "--close-on-success";

    /// <summary>2: import the recording. The steps the import adds (a wait for each window, one for each file the bot
    /// returns) are said on n8n's review page, where they show.</summary>
    public static NextLine Import() => new("2. Import the recording in n8n", "Upload it in n8n's Import a bot form.", ShowFile, null, true);

    /// <param name="app">The recorded program's file name.</param>
    /// <param name="tool">The policy tool (<see cref="FindPolicyTool"/>), or null when there is none to start.</param>
    /// <param name="changePath">The saved policy change file.</param>
    public static NextLine Allow(string app, string? tool, string changePath, AllowState state)
    {
        var title = $"1. Allow {app} on this machine";
        if (state == AllowState.Allowed) return new($"1. {app} is allowed on this machine", "The policy tool reported success.", null, null, false);
        if (tool is null)
            return new(title, $"Give {WindowRules.FileName(changePath)} to an administrator of this machine, who runs:", null, $"{PolicyToolFile} {ApplyArguments(changePath)}", false);
        return state == AllowState.Waiting
            ? new(title, "The policy tool is open in its own window: answer there.", AllowButton, null, false)
            : new(title, "The policy tool opens as administrator. It shows what it will allow and asks you.", AllowButton, null, true);
    }

    /// <summary>
    /// The policy tool of the install the recorder is part of: <c>runner\RpaPolicy.exe</c> beside the recorder's own
    /// folder, when it is there and under <paramref name="programFiles"/>. A copy of the recorder somewhere else (a
    /// folder its user can change) gets null: the bar does not start a program found beside it as administrator.
    /// </summary>
    public static string? FindPolicyTool(string recorderFolder, string programFiles, Func<string, bool> exists)
    {
        var tool = Path.GetFullPath(Path.Combine(recorderFolder, "..", "runner", PolicyToolFile));
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(programFiles)) + Path.DirectorySeparatorChar;
        return tool.StartsWith(root, StringComparison.OrdinalIgnoreCase) && exists(tool) ? tool : null;
    }

    /// <summary>The policy tool's arguments: <c>apply</c> and the change file, quoted as Windows programs read them. This
    /// is the command an administrator runs by hand.</summary>
    public static string ApplyArguments(string changePath) => CommandLine.JoinArguments(["apply", changePath]);

    /// <summary>The arguments the bar starts the tool with: <see cref="ApplyArguments"/> and <see cref="CloseOnSuccess"/>.</summary>
    public static string StartArguments(string changePath) => CommandLine.JoinArguments(["apply", changePath, CloseOnSuccess]);

    /// <summary>Explorer's arguments that open a folder with the file selected.</summary>
    public static string ExplorerSelect(string path) => $"/select,\"{path}\"";

    /// <summary>The policy tool's exit codes: 0 applied (or nothing to change), 1 refused or failed, 3 declined.</summary>
    public static AllowOutcome Outcome(int exitCode) => exitCode switch
    {
        0 => new(true, null, NoticeTone.Information),
        3 => new(false, $"You answered no in the policy tool, so nothing was changed. Choose {AllowButton} to try again.", NoticeTone.Information),
        1 => new(false, $"The policy tool did not change the policy; its window said why. Choose {AllowButton} to try again, or give the file to an administrator.", NoticeTone.Check),
        _ => new(false, $"The policy tool ended with code {exitCode}, so the bar cannot tell whether the policy changed. An administrator can check it with {PolicyToolFile} show.", NoticeTone.Check),
    };

    public static string NotStarted(string reason) => $"The policy tool did not start: {reason}";
}
