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

    public static RpcException NotUnique(int count, string what) =>
        new(NotUniqueCode, "not_unique", $"not_unique: the primary target {what} matched {count} visible elements");

    public static RpcException ExpectedFileMissing(string why) =>
        new(ExpectedFileMissingCode, "expected_file_missing", $"expected_file_missing: {why}");

    public static RpcException Timeout(string why) =>
        new(TimeoutCode, "timeout", $"timeout: {why}");

    public static RpcException NoRun() =>
        new(NoRunCode, "no_run", "no_run: missing or wrong runId (no active run with that id)");

    public static RpcException InvalidParamsError(string why) =>
        new(InvalidParams, "invalid_params", $"invalid params: {why}");
}
