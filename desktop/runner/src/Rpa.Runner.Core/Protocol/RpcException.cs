using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Protocol;

/// <summary>
/// A JSON-RPC error the runner returns to the caller. Messages are human-readable and never contain typed values,
/// tokens or file contents: build them only from locator fields, window titles, counts and fixed text.
/// </summary>
public sealed class RpcException : Exception
{
    public RpcException(int code, string name, string message) : base(message)
    {
        Code = code;
        Name = name;
    }

    public int Code { get; }

    /// <summary>The contract's snake_case name (runner_busy, not_found, ...), also sent as error.data.name.</summary>
    public string Name { get; }
}

/// <summary>The contract's error codes, plus the JSON-RPC standard ones.</summary>
public static class RpcErrors
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    public const int RunnerBusyCode = -32001;
    public const int DesktopUnavailableCode = -32002;
    public const int PolicyRefusedCode = -32003;
    public const int NotFoundCode = -32004;
    public const int NotUniqueCode = -32005;
    public const int ExpectedFileMissingCode = -32006;
    public const int TimeoutCode = -32007;
    public const int NoRunCode = -32008;

    public static RpcException RunnerBusy() =>
        new(RunnerBusyCode, "runner_busy", "runner_busy: another run holds the lock");

    public static RpcException DesktopUnavailable(string why) =>
        new(DesktopUnavailableCode, "desktop_unavailable", $"desktop_unavailable: {why}");

    public static RpcException PolicyRefused(string why) =>
        new(PolicyRefusedCode, "policy_refused", $"policy_refused: {why}");

    public static RpcException NotFound(string what, string? windowTitle) =>
        new(NotFoundCode, "not_found",
            windowTitle is null
                ? $"not_found: no element matched {what} (no matching window of the run)"
                : $"not_found: no element matched {what} in window \"{windowTitle}\"");

    /// <summary>The primary target matched several visible elements: what it found, what to add, then the target.</summary>
    public static RpcException NotUnique(int count, Target target) =>
        new(NotUniqueCode, "not_unique",
            $"not_unique: found {count} {Found(target, count)}. Add what tells them apart to the step's target: the window, a parent " +
            $"with an automationId, or a condition such as {MissingConditions(target)}. Target: {target.Describe()}");

    /// <summary>The act's element stayed disabled until the timeout: what it found, what to do instead, then the target
    /// (none for the focused element).</summary>
    public static RpcException Disabled(Target? target)
    {
        const string hint = "If a person can click it, target an enabled element inside it, or use key steps (Tab, Space).";
        return Timeout(target is null
            ? $"found the focused element disabled. {hint}"
            : $"found the {Found(target, 1)} disabled. {hint} Target: {target.Describe()}");
    }

    /// <summary>The only window that matched belongs to a copy of an allowed app that this run did not start.</summary>
    public static RpcException OtherCopy(WindowSel window, string exe) =>
        PolicyRefused($"found its window in a copy of {exe} that this run did not start (most often one left open before the run). " +
            $"Close that copy on the runner machine (or end its process), then run again. Window: {window}");

    public static RpcException ExpectedFileMissing(string why) =>
        new(ExpectedFileMissingCode, "expected_file_missing", $"expected_file_missing: {why}");

    public static RpcException Timeout(string why) =>
        new(TimeoutCode, "timeout", $"timeout: {why}");

    public static RpcException NoRun() =>
        new(NoRunCode, "no_run", "no_run: missing or wrong runId (no active run with that id)");

    public static RpcException InvalidParamsError(string why) =>
        new(InvalidParams, "invalid_params", $"invalid params: {why}");

    /// <summary>What the target's last condition finds, as a person names it: <c>buttons named "Save"</c>,
    /// <c>text box with the id "txtFrom"</c>, <c>elements</c>.</summary>
    private static string Found(Target target, int count)
    {
        var last = target.Path[^1];
        var word = ControlWord(last.ControlType);
        var noun = count == 1 ? word : Regex.IsMatch(word, "(s|x|ch|sh)$") ? word + "es" : word + "s";
        if (last.Name is not null) return $"{noun} named {Describe.Quote(last.Name)}";
        if (last.AutomationId is not null) return $"{noun} with the id {Describe.Quote(last.AutomationId)}";
        return noun;
    }

    /// <summary>A UI Automation control type as a person names it: Button is button, Edit is text box, CheckBox is check box.</summary>
    private static string ControlWord(string? controlType) => controlType?.ToLowerInvariant() switch
    {
        null => "element",
        "edit" => "text box",
        "hyperlink" => "link",
        "text" => "label",
        _ => Regex.Replace(controlType, "([a-z])([A-Z])", "$1 $2").ToLowerInvariant(),
    };

    /// <summary>The conditions the target's last condition does not use yet: <c>name, automationId or className</c>.</summary>
    private static string MissingConditions(Target target)
    {
        var last = target.Path[^1];
        var missing = new[] { last.Name is null ? "name" : null, last.AutomationId is null ? "automationId" : null, "className" }
            .OfType<string>().ToList();
        return missing.Count > 1 ? $"{string.Join(", ", missing.Take(missing.Count - 1))} or {missing[^1]}" : missing[0];
    }
}
