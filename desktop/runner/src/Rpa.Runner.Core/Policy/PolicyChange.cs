using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Policy;

/// <summary>The policy file's new text, and the lines an administrator reads before approving it: one per thing the
/// change adds or updates, warnings under the lines they belong to, and a count line last (empty when the policy
/// already has everything).</summary>
public sealed record PolicyChangeResult(string Json, IReadOnlyList<string> Summary);

/// <summary>
/// Merges a change file into the policy. A change is a JSON object with any of <c>allowedApps</c>,
/// <c>writeControls</c>, <c>gatedKeys</c>, <c>helperProcesses</c> and <c>clipboardRead</c>, in the policy file's own
/// shape. It only adds: lists are unioned, <c>clipboardRead</c> may only be <c>true</c>, and <c>maxFileBytes</c> and
/// unknown keys are refused. An <c>allowedApps</c> entry with the exe and path of an existing entry (case-insensitive)
/// is merged into it: a <c>sha256</c> sets or changes the pin (none keeps it), <c>allowedArgs</c> lists are added, and
/// <c>allowUserWritable</c> can be turned on but not off.
/// <para>
/// The summary is all the administrator approves, and a change file may come from a user who is not one. So a change
/// has limits (entries, arguments per list, value lengths; PolicyCommand limits the length of the summary), every
/// value is shown as a JSON string literal in plain ASCII, and the lines that widen what may run are printed last,
/// next to the prompt.
/// </para>
/// </summary>
public static class PolicyChange
{
    public const int MaxEntries = 40;
    public const int MaxArguments = 20;
    public const int MaxValueLength = 260;

    private const string NonAsciiWarning = @"WARNING: this line holds characters outside plain ASCII, shown as \u escapes";
    private const string SpacesWarning = "WARNING: a value in this line has leading, trailing or repeated spaces";
    private const string HelperWarning = "WARNING: any program at this path counts as part of the app that started it";

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

    private static RunnerPolicy.InvalidPolicyException Refused(string message) => new(message);

    /// <summary>
    /// The policy with the change merged in. <paramref name="currentJson"/> may be empty (no policy yet). Throws
    /// <see cref="RunnerPolicy.InvalidPolicyException"/> for a change that is refused, and when the current policy or
    /// the result is one the runner would refuse.
    /// </summary>
    public static PolicyChangeResult Apply(string currentJson, string changeJson)
    {
        var current = string.IsNullOrWhiteSpace(currentJson) ? new RunnerPolicy() : Parse(currentJson, "the current policy");
        var writableOff = CheckChange(changeJson);
        var change = RunnerPolicy.Parse(changeJson, "the change");
        CheckSize(change);

        var lines = new List<string>();
        void Add(string format, params string[] values)
        {
            lines.Add(string.Format(CultureInfo.InvariantCulture, format, values.Select(Literal).ToArray<object>()));
            if (values.Any(value => value.Any(c => c is < ' ' or > '~'))) lines.Add(NonAsciiWarning);
            // Spaces are shown as they are; a run of them can push the rest of a value onto the next row.
            if (values.Any(value => value.StartsWith(' ') || value.EndsWith(' ') || value.Contains("  ", StringComparison.Ordinal))) lines.Add(SpacesWarning);
        }

        // Lines that only tighten come first; the lines that widen what may run follow, nearest the prompt.
        var writes = current.WriteControls.ToList();
        foreach (var write in change.WriteControls)
        {
            if (writes.Any(w => Same(w.Exe, write.Exe) && w.AutomationId == write.AutomationId)) continue;
            writes.Add(write);
            Add("Add write control {0} / {1}", write.Exe, write.AutomationId);
        }
        var addedWrites = writes.Count - current.WriteControls.Count;

        var keys = current.GatedKeys.ToList();
        foreach (var key in change.GatedKeys)
        {
            if (keys.Contains(key)) continue;
            keys.Add(key);
            Add("Add gated key {0}", key.ToString());
        }
        var addedKeys = keys.Count - current.GatedKeys.Count;

        var apps = current.AllowedApps.ToList();
        var changedApps = 0;
        for (var i = 0; i < change.AllowedApps.Count; i++)
        {
            var app = change.AllowedApps[i];
            var at = apps.FindIndex(a => Same(a.Exe, app.Exe) && Same(a.Path, app.Path));
            IReadOnlyList<IReadOnlyList<string>> lists;
            bool writable;
            string path;
            if (at < 0)
            {
                lists = NewLists([], app.AllowedArgs);
                (writable, path) = (app.AllowUserWritable, app.Path);
                apps.Add(app with { AllowedArgs = lists });
                Add("Allow app {0} at {1}" + (app.Sha256 is null ? "" : $" (SHA-256 pinned {app.Sha256})"), app.Exe, app.Path);
            }
            else
            {
                // The existing entry takes what the change adds and loses nothing; it keeps its own spelling.
                var old = apps[at];
                if (old.AllowUserWritable && writableOff.Contains(i))
                    throw Refused($"a policy change cannot turn allowUserWritable off for {old.Path}");
                lists = NewLists(old.AllowedArgs, app.AllowedArgs);
                (writable, path) = (old.AllowUserWritable || app.AllowUserWritable, old.Path);
                var parts = new List<string>();
                if (app.Sha256 is not null && app.Sha256 != old.Sha256)
                    parts.Add(old.Sha256 is null ? $"SHA-256 pinned {app.Sha256}" : $"SHA-256 pin changed from {old.Sha256} to {app.Sha256}");
                if (lists.Count > 0) parts.Add("allowed arguments added");
                if (writable && !old.AllowUserWritable) parts.Add("user-writable path allowed");
                if (parts.Count == 0) continue;
                apps[at] = old with { Sha256 = app.Sha256 ?? old.Sha256, AllowedArgs = [.. old.AllowedArgs, .. lists], AllowUserWritable = writable };
                Add($"Update app {{0}} at {{1}} ({string.Join("; ", parts)})", old.Exe, old.Path);
            }
            changedApps++;
            if (writable) lines.Add($"WARNING: {Literal(path)} can be changed by the runner's own user");
            foreach (var list in lists)
                Add("  with arguments: " + (list.Count == 0 ? "(none)" : string.Join(' ', list.Select((_, n) => $"{{{n}}}"))), [.. list]);
        }

        var helpers = current.HelperProcesses.ToList();
        foreach (var helper in change.HelperProcesses)
        {
            if (helpers.Any(h => Same(h.Exe, helper.Exe) && Same(h.PathPattern, helper.PathPattern))) continue;
            helpers.Add(helper);
            Add("Add helper process {0} at {1}", helper.Exe, helper.PathPattern);
            lines.Add(HelperWarning);
        }
        var addedHelpers = helpers.Count - current.HelperProcesses.Count;

        var clipboardOn = change.ClipboardRead && !current.ClipboardRead;
        if (clipboardOn) lines.Add("Turn on clipboard read");

        if (lines.Count > 0)
        {
            lines.Add($"This change: {changedApps} app(s) allowed or updated, {addedHelpers} helper process pattern(s), {addedWrites} write control(s), " +
                      $"{addedKeys} gated key(s){(clipboardOn ? ", clipboard read turned on" : "")}.");
        }

        var json = JsonSerializer.Serialize(new FileOut(
            apps.Select(a => new AppOut(a.Exe, a.Path, a.Sha256, a.AllowedArgs.Count > 0 ? a.AllowedArgs : null, a.AllowUserWritable ? true : null)).ToList(),
            writes,
            keys.Select(k => k.ToString()).ToList(),
            current.MaxFileBytes,
            helpers.Count > 0 ? helpers.Select(h => new HelperOut(h.Exe, h.PathPattern)).ToList() : null,
            current.ClipboardRead || change.ClipboardRead ? true : null), OutOptions) + Environment.NewLine;
        RunnerPolicy.Parse(json, "the changed policy");
        return new PolicyChangeResult(json, lines);
    }

    /// <summary>
    /// A value as the summary shows it: a JSON string literal in plain ASCII. The double quote and the backslash are
    /// escaped and every character outside 0x20 to 0x7E is written as <c>\uXXXX</c>. The quotes mark where a value
    /// starts and ends, and a character outside printable ASCII (a look-alike or an invisible one, for example) is
    /// shown as its code. Spaces are shown as they are.
    /// </summary>
    internal static string Literal(string value)
    {
        var literal = new StringBuilder("\"", value.Length + 2);
        foreach (var c in value)
        {
            if (c is '"' or '\\') literal.Append('\\').Append(c);
            else if (c is >= ' ' and <= '~') literal.Append(c);
            else literal.Append(CultureInfo.InvariantCulture, $"\\u{(int)c:X4}");
        }
        return literal.Append('"').ToString();
    }

    private static readonly JsonDocumentOptions DocumentOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>
    /// <see cref="RunnerPolicy.Parse"/> for a policy file the tool reads, after refusing the null entries and
    /// arguments that parser fails on without a message.
    /// </summary>
    internal static RunnerPolicy Parse(string json, string source)
    {
        try
        {
            using var document = JsonDocument.Parse(json, DocumentOptions);
            CheckEntries(document.RootElement, $"{source}: ");
        }
        catch (JsonException)
        {
            // Not JSON: the parser below says why.
        }
        return RunnerPolicy.Parse(json, source);
    }

    /// <summary>Every entry of the lists of objects is an object, and every allowed argument is text.</summary>
    private static void CheckEntries(JsonElement root, string source)
    {
        if (root.ValueKind != JsonValueKind.Object) return;
        foreach (var property in root.EnumerateObject())
        {
            if (property.Name is not ("allowedApps" or "writeControls" or "helperProcesses") || property.Value.ValueKind != JsonValueKind.Array) continue;
            foreach (var entry in property.Value.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) throw Refused($"{source}an entry in {property.Name} must be an object");
                var arguments = entry.EnumerateObject()
                    .Where(p => p.NameEquals("allowedArgs") && p.Value.ValueKind == JsonValueKind.Array)
                    .SelectMany(p => p.Value.EnumerateArray())
                    .Where(list => list.ValueKind == JsonValueKind.Array)
                    .SelectMany(list => list.EnumerateArray());
                if (arguments.Any(argument => argument.ValueKind != JsonValueKind.String)) throw Refused($"{source}an allowed argument must be text");
            }
        }
    }

    /// <summary>
    /// The rules a change has beyond a policy file's: no maxFileBytes, no unknown key, clipboardRead only true, and no
    /// short (8.3) name in a path, which would name an existing entry's file without being that entry. Returns the
    /// positions of the allowedApps entries that write <c>allowUserWritable: false</c>, which the parsed policy cannot
    /// tell from an entry that leaves it out.
    /// </summary>
    private static HashSet<int> CheckChange(string changeJson)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(changeJson, DocumentOptions);
        }
        catch (JsonException e)
        {
            throw Refused($"the change: {e.Message}");
        }
        using (document)
        {
            var writableOff = new HashSet<int>();
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw Refused("the change: must be a JSON object");
            CheckEntries(document.RootElement, "");
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.NameEquals("maxFileBytes")) throw Refused("the change: maxFileBytes cannot be changed by a change (edit the policy file)");
                if (!ChangeKeys.Contains(property.Name)) throw Refused($"the change: unknown key \"{property.Name}\"");
                if (property.NameEquals("clipboardRead") && property.Value.ValueKind != JsonValueKind.True)
                    throw Refused("the change: clipboardRead may only be true (a change only adds)");
                if (property.Value.ValueKind != JsonValueKind.Array) continue;
                var entries = property.Value.EnumerateArray().ToList();
                if (property.NameEquals("allowedApps"))
                {
                    foreach (var app in entries) CheckFullPath(app, "path");
                    writableOff = Enumerable.Range(0, entries.Count)
                        .Where(at => entries[at].TryGetProperty("allowUserWritable", out var value) && value.ValueKind == JsonValueKind.False)
                        .ToHashSet();
                }
                if (property.NameEquals("helperProcesses"))
                {
                    foreach (var helper in entries) CheckFullPath(helper, "pathPattern");
                }
            }
            return writableOff;
        }
    }

    private static void CheckFullPath(JsonElement entry, string key)
    {
        if (entry.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String) RefuseShortName(value.GetString()!);
    }

    /// <summary>Refuses a path that holds <c>~</c> followed by a digit, as a short (8.3) name does.</summary>
    internal static void RefuseShortName(string path)
    {
        if (Regex.IsMatch(path, "~[0-9]")) throw Refused($"write the full path, not a short (8.3) name: {Literal(path)}");
    }

    /// <summary>The limits on a change: its entries, the arguments in a list and the length of a value.</summary>
    private static void CheckSize(RunnerPolicy change)
    {
        var lists = change.AllowedApps.SelectMany(a => a.AllowedArgs).ToList();
        var entries = change.AllowedApps.Count + lists.Count + change.WriteControls.Count + change.GatedKeys.Count + change.HelperProcesses.Count;
        if (entries > MaxEntries) throw Refused($"a change may hold at most {MaxEntries} entries; this one holds {entries}");
        if (lists.Any(list => list.Count > MaxArguments)) throw Refused($"an allowed argument list may hold at most {MaxArguments} arguments");
        var values = change.AllowedApps.SelectMany(a => new[] { a.Exe, a.Path })
            .Concat(lists.SelectMany(list => list))
            .Concat(change.WriteControls.SelectMany(w => new[] { w.Exe, w.AutomationId }))
            .Concat(change.HelperProcesses.SelectMany(h => new[] { h.Exe, h.PathPattern }));
        if (values.Any(value => value.Length > MaxValueLength)) throw Refused($"a value in the change is longer than {MaxValueLength} characters");
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>The argument lists the entry does not have yet, each once (a list is the same when its strings are
    /// equal in order).</summary>
    private static List<IReadOnlyList<string>> NewLists(IReadOnlyList<IReadOnlyList<string>> existing, IReadOnlyList<IReadOnlyList<string>> lists)
    {
        var added = new List<IReadOnlyList<string>>();
        foreach (var list in lists)
        {
            if (!existing.Concat(added).Any(l => l.SequenceEqual(list, StringComparer.Ordinal))) added.Add(list);
        }
        return added;
    }
}
