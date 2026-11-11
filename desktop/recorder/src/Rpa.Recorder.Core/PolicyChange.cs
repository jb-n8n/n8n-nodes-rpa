using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rpa.Recorder.Core;

/// <summary>
/// A policy change file that allows the recorded application, in the format <c>RpaPolicy.exe apply</c> reads
/// (desktop/runner/src/Rpa.Runner.Core/Policy/PolicyChange.cs): one <c>allowedApps</c> entry with the program's path
/// and SHA-256, and the recorded arguments when there are any. It lists no write controls and no gated keys: declaring
/// writes stays with the approver, and an administrator applies the change.
/// </summary>
public sealed record PolicyChange(string Exe, string Path, string Sha256, IReadOnlyList<string> Args)
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public string ToJson()
    {
        var app = new JsonObject { ["exe"] = Exe, ["path"] = Path, ["sha256"] = Sha256 };
        if (Args.Count > 0) app["allowedArgs"] = new JsonArray(new JsonArray(Args.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray()));
        return new JsonObject { ["allowedApps"] = new JsonArray(app) }.ToJsonString(Indented);
    }
}
