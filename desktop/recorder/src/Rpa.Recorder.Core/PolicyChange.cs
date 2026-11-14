using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rpa.Recorder.Core;

/// <summary>A control of the recorded app as the change file names it: its program, its automation id and the name the
/// bar showed for it.</summary>
public sealed record ProposedControl(string Exe, string AutomationId, string Name);

/// <summary>
/// A policy change file that allows the recorded application, in the format <c>RpaPolicy.exe apply</c> reads
/// (desktop/runner/src/Rpa.Runner.Core/Policy/PolicyChange.cs): one <c>allowedApps</c> entry with the program's path
/// and SHA-256, and the recorded arguments when there are any. <see cref="WriteControls"/> are the clicked controls
/// the engine's rule takes for writes (<see cref="WriteRules"/>), to protect; <see cref="LeftOut"/> those it took for
/// writes and left out because their ids are standard dialog button ids. The tool shows both in its one question and
/// keeps only the write controls. No gated keys are proposed. An administrator applies the change.
/// </summary>
public sealed record PolicyChange(string Exe, string Path, string Sha256, IReadOnlyList<string> Args)
{
    /// <summary>The policy tool's limits on a change (a test holds them to the tool's): its entries, each argument list,
    /// write control and left-out control counting as one, and the length of a value.</summary>
    public const int MaxEntries = 40;
    public const int MaxValueLength = 260;

    /// <summary>The most of a control's name the file holds.</summary>
    public const int MaxNameLength = 100;

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public IReadOnlyList<ProposedControl> WriteControls { get; init; } = [];
    public IReadOnlyList<ProposedControl> LeftOut { get; init; } = [];

    public string ToJson()
    {
        var app = new JsonObject { ["exe"] = Exe, ["path"] = Path, ["sha256"] = Sha256 };
        if (Args.Count > 0) app["allowedArgs"] = new JsonArray(new JsonArray(Args.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray()));
        var change = new JsonObject { ["allowedApps"] = new JsonArray(app) };
        if (WriteControls.Count > 0) change["writeControls"] = Controls(WriteControls);
        if (LeftOut.Count > 0) change["leftOutControls"] = Controls(LeftOut);
        return change.ToJsonString(Indented);
    }

    private static JsonArray Controls(IEnumerable<ProposedControl> controls) =>
        new(controls.Select(c => (JsonNode)new JsonObject { ["exe"] = c.Exe, ["automationId"] = c.AutomationId, ["name"] = c.Name }).ToArray());
}
