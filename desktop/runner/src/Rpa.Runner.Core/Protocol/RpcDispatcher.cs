using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rpa.Runner.Core.Protocol;

/// <summary>
/// JSON-RPC 2.0 framing: one request per message, <c>id</c> echoed, errors as <c>{ code, message, data: { name } }</c>.
/// Batches are refused. Logs the method, the outcome and the duration, never params or results.
/// </summary>
public sealed class RpcDispatcher
{
    private readonly RunnerService _service;
    private readonly RunnerLog _log;

    public RpcDispatcher(RunnerService service, RunnerLog log)
    {
        _service = service;
        _log = log;
    }

    /// <summary>Handles one message; returns the response text, or null for a notification (no id).</summary>
    public async Task<string?> HandleAsync(string message, CancellationToken ct)
    {
        JsonNode? id = null;
        string? method = null;
        var sw = Stopwatch.StartNew();
        try
        {
            JsonDocument doc;
            try { doc = JsonDocument.Parse(message); }
            catch (JsonException) { throw new RpcException(RpcErrors.ParseError, "parse_error", "parse error: the message is not JSON"); }
            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                    throw new RpcException(RpcErrors.InvalidRequest, "invalid_request", "invalid request: send one JSON-RPC request object per message");
                var hasId = root.TryGetProperty("id", out var idEl);
                if (hasId)
                {
                    if (idEl.ValueKind is not (JsonValueKind.String or JsonValueKind.Number or JsonValueKind.Null))
                        throw new RpcException(RpcErrors.InvalidRequest, "invalid_request", "invalid request: id must be a string or a number");
                    id = JsonNode.Parse(idEl.GetRawText());
                }
                if (!root.TryGetProperty("jsonrpc", out var v) || v.ValueKind != JsonValueKind.String || v.GetString() != "2.0")
                    throw new RpcException(RpcErrors.InvalidRequest, "invalid_request", "invalid request: jsonrpc must be \"2.0\"");
                if (!root.TryGetProperty("method", out var m) || m.ValueKind != JsonValueKind.String)
                    throw new RpcException(RpcErrors.InvalidRequest, "invalid_request", "invalid request: method must be a string");
                method = m.GetString()!;
                JsonElement? pe = root.TryGetProperty("params", out var pv) ? pv.Clone() : null;
                var p = new Params(pe);
                var name = method;
                var result = await Task.Run(() => _service.Invoke(name, p, ct), ct).ConfigureAwait(false);
                _log.Info($"{method} ok {sw.ElapsedMilliseconds}ms");
                if (!hasId) return null;
                return new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result }.ToJsonString();
            }
        }
        catch (RpcException e)
        {
            _log.Info($"{method ?? "(invalid)"} error {e.Code} {e.Name} {sw.ElapsedMilliseconds}ms");
            return Error(id, e.Code, e.Message, e.Name);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return null;
        }
        catch (Exception e)
        {
            // Unexpected: log the type and the stack, never the message (an arbitrary exception's message could echo a
            // value).
            _log.Error($"{method ?? "(invalid)"} internal error {e.GetType().FullName} {sw.ElapsedMilliseconds}ms{Environment.NewLine}{e.StackTrace}");
            return Error(id, RpcErrors.InternalError, "internal error in the runner (see the runner log)", "internal_error");
        }
    }

    private static string Error(JsonNode? id, int code, string message, string name) =>
        new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["data"] = new JsonObject { ["name"] = name } },
        }.ToJsonString();
}
