using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rpa.Recorder.Core;

/// <summary>
/// A recording file, format <c>rpa-recording/1</c>, as the engine's importer reads it (the format is defined at the top
/// of packages/engine/src/import/recording.ts): the name the person gave, the application, the events, and the run
/// variables whose fills were typed into secret fields. <see cref="ToJson"/> writes only the keys that format lists.
/// </summary>
public sealed record RecordingFile(string Name, string Exe, IReadOnlyList<string> Args, IReadOnlyList<RecordedStep> Events, IReadOnlyList<string> SecretVariables)
{
    public const string Format = "rpa-recording/1";
    /// <summary>The most events the importer reads from one recording.</summary>
    public const int MaxEvents = 400;
    /// <summary>The most steps a desktop step set has (the engine's step parser).</summary>
    public const int MaxSteps = 200;

    /// <summary>About how many steps Import Steps makes of this recording: one per event (a launch and a scope become a
    /// wait), plus a check of the exported file after each export. It leaves out steps it cannot use, so it may be fewer.</summary>
    public int EstimatedSteps => Events.Count + Events.Count(e => e.ExportFile is not null);

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public string ToJson()
    {
        var app = new JsonObject { ["exe"] = Exe };
        if (Args.Count > 0) app["args"] = Strings(Args);
        var file = new JsonObject
        {
            ["format"] = Format,
            ["name"] = Name,
            ["app"] = app,
            ["events"] = new JsonArray(Events.Select(e => (JsonNode)Event(e)).ToArray()),
            ["secretVariables"] = Strings(SecretVariables),
        };
        return file.ToJsonString(Indented);
    }

    private static JsonObject Event(RecordedStep e)
    {
        var o = new JsonObject
        {
            ["at"] = e.At.ToString("o", CultureInfo.InvariantCulture),
            ["kind"] = e.Kind.ToString().ToLowerInvariant(),
        };
        if (e.Kind == StepKind.Launch)
        {
            o["exe"] = e.Exe;
            if (e.Args.Count > 0) o["args"] = Strings(e.Args);
        }
        if (e.Window is not null) o["window"] = Window(e.Window);
        if (e.Target is not null) o["target"] = Target(e.Target);
        o["label"] = e.Label;
        switch (e.Kind)
        {
            case StepKind.Fill:
                o["value"] = e.Value;
                if (e.ExportFile is not null) o["exportFile"] = e.ExportFile;
                if (e.Secret) o["secret"] = true;
                break;
            case StepKind.Select: o["option"] = e.Option; break;
            case StepKind.Check: o["checked"] = e.Checked; break;
            case StepKind.Key: o["chord"] = e.Chord; break;
            case StepKind.Read: o["as"] = e.As; break;
        }
        if (e.Double) o["double"] = true;
        if (e.Positional) o["positional"] = true;
        return o;
    }

    private static JsonObject Target(RecordedTarget t) => new()
    {
        ["window"] = Window(t.Window),
        ["path"] = new JsonArray(t.Path.Select(c => (JsonNode)Condition(c)).ToArray()),
    };

    private static JsonObject Window(RecordedWindow w)
    {
        var o = new JsonObject();
        if (w.Exe is not null) o["exe"] = w.Exe;
        if (w.Title is not null) o["title"] = w.Title;
        if (w.ClassName is not null) o["className"] = w.ClassName;
        return o;
    }

    private static JsonObject Condition(RecordedCondition c)
    {
        var o = new JsonObject();
        if (c.ControlType is not null) o["controlType"] = c.ControlType;
        if (c.AutomationId is not null) o["automationId"] = c.AutomationId;
        if (c.Name is not null) o["name"] = c.Name;
        return o;
    }

    private static JsonArray Strings(IEnumerable<string> values) => new(values.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray());
}
