using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rpa.Runner.Core.Policy;

/// <summary>The policy file's new text, and one plain line per thing the change adds or updates (empty when the policy
/// already has all of it).</summary>
public sealed record PolicyChangeResult(string Json, IReadOnlyList<string> Summary);

/// <summary>
/// Merges a change file into the policy. A change is a JSON object with any of <c>allowedApps</c>,
/// <c>writeControls</c>, <c>gatedKeys</c>, <c>helperProcesses</c> and <c>clipboardRead</c>, in the policy file's own
/// shape. It only adds: lists are unioned, <c>clipboardRead</c> may only be <c>true</c>, and <c>maxFileBytes</c> and
/// unknown keys are refused. The one replacement: an <c>allowedApps</c> entry with the exe and path of an existing
/// entry (case-insensitive) takes its place.
/// </summary>
public static class PolicyChange
{
    private static readonly string[] ChangeKeys = ["allowedApps", "writeControls", "gatedKeys", "helperProcesses", "clipboardRead"];

    // Keys in the order of policy.example.json; an entry's unset options are left out.
    private sealed record FileOut(List<AppOut> AllowedApps, List<RunnerPolicy.WriteControl> WriteControls, List<string> GatedKeys,
        long MaxFileBytes, List<HelperOut>? HelperProcesses, bool? ClipboardRead);

    private sealed record AppOut(string Exe, string Path, string? Sha256, IReadOnlyList<IReadOnlyList<string>>? AllowedArgs, bool? AllowUserWritable);

    private sealed record HelperOut(string Exe, string PathPattern);

    private static readonly JsonSerializerOptions OutOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Keeps "Ctrl+S" and non-ASCII paths readable; the file is never put into HTML.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// The policy with the change merged in. <paramref name="currentJson"/> may be empty (no policy yet). Throws
    /// <see cref="RunnerPolicy.InvalidPolicyException"/> for a change that is refused, and when the current policy or
    /// the result is one the runner would refuse.
    /// </summary>
    public static PolicyChangeResult Apply(string currentJson, string changeJson)
    {
        var current = string.IsNullOrWhiteSpace(currentJson) ? new RunnerPolicy() : RunnerPolicy.Parse(currentJson, "the current policy");
        CheckKeys(changeJson);
        var change = RunnerPolicy.Parse(changeJson, "the change");
        var summary = new List<string>();

        var apps = current.AllowedApps.ToList();
        foreach (var app in change.AllowedApps)
        {
            var at = apps.FindIndex(a => Same(a.Exe, app.Exe) && Same(a.Path, app.Path));
            if (at >= 0 && SameOptions(apps[at], app)) continue;
            if (at >= 0)
            {
                apps[at] = app;
                summary.Add($"Update app {app.Exe} at {app.Path}");
            }
            else
            {
                apps.Add(app);
                summary.Add($"Allow app {app.Exe} at {app.Path}{(app.Sha256 is null ? "" : " (SHA-256 pinned)")}");
            }
            if (app.AllowUserWritable) summary.Add($"WARNING: {app.Path} can be changed by the runner's own user");
        }

        var writes = current.WriteControls.ToList();
        foreach (var write in change.WriteControls)
        {
            if (writes.Any(w => Same(w.Exe, write.Exe) && w.AutomationId == write.AutomationId)) continue;
            writes.Add(write);
            summary.Add($"Add write control {write.Exe} / {write.AutomationId}");
        }

        var keys = current.GatedKeys.ToList();
        foreach (var key in change.GatedKeys)
        {
            if (keys.Contains(key)) continue;
            keys.Add(key);
            summary.Add($"Add gated key {key}");
        }

        var helpers = current.HelperProcesses.ToList();
        foreach (var helper in change.HelperProcesses)
        {
            if (helpers.Any(h => Same(h.Exe, helper.Exe) && Same(h.PathPattern, helper.PathPattern))) continue;
            helpers.Add(helper);
            summary.Add($"Add helper process {helper.Exe} at {helper.PathPattern}");
        }

        if (change.ClipboardRead && !current.ClipboardRead) summary.Add("Turn on clipboard read");

        // The lines are what the administrator approves: a value must not be able to end a line, move the cursor or
        // reorder the text, which could hide a line or fake one.
        if (summary.Any(line => line.Any(Deceptive)))
            throw new RunnerPolicy.InvalidPolicyException("the change: names, paths and ids must not contain control characters");

        var json = JsonSerializer.Serialize(new FileOut(
            apps.Select(a => new AppOut(a.Exe, a.Path, a.Sha256, a.AllowedArgs.Count > 0 ? a.AllowedArgs : null, a.AllowUserWritable ? true : null)).ToList(),
            writes,
            keys.Select(k => k.ToString()).ToList(),
            current.MaxFileBytes,
            helpers.Count > 0 ? helpers.Select(h => new HelperOut(h.Exe, h.PathPattern)).ToList() : null,
            current.ClipboardRead || change.ClipboardRead ? true : null), OutOptions) + Environment.NewLine;
        RunnerPolicy.Parse(json, "the changed policy");
        return new PolicyChangeResult(json, summary);
    }

    /// <summary>The top-level rules a policy file does not have: no maxFileBytes, no unknown key, clipboardRead only true.</summary>
    private static void CheckKeys(string changeJson)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(changeJson, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        }
        catch (JsonException e)
        {
            throw new RunnerPolicy.InvalidPolicyException($"the change: {e.Message}");
        }
        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new RunnerPolicy.InvalidPolicyException("the change: must be a JSON object");
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.NameEquals("maxFileBytes"))
                    throw new RunnerPolicy.InvalidPolicyException("the change: maxFileBytes cannot be changed by a change (edit the policy file)");
                if (!ChangeKeys.Contains(property.Name))
                    throw new RunnerPolicy.InvalidPolicyException($"the change: unknown key \"{property.Name}\"");
                if (property.NameEquals("clipboardRead") && property.Value.ValueKind != JsonValueKind.True)
                    throw new RunnerPolicy.InvalidPolicyException("the change: clipboardRead may only be true (a change only adds)");
            }
        }
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private static bool SameOptions(RunnerPolicy.AllowedApp a, RunnerPolicy.AllowedApp b) =>
        a.Sha256 == b.Sha256 && a.AllowUserWritable == b.AllowUserWritable && a.AllowedArgs.Count == b.AllowedArgs.Count &&
        a.AllowedArgs.Zip(b.AllowedArgs).All(pair => pair.First.SequenceEqual(pair.Second, StringComparer.Ordinal));

    private static bool Deceptive(char c) =>
        char.IsControl(c) || char.GetUnicodeCategory(c) is UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator;
}
