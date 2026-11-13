using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Policy;

/// <summary>The policy file's new text, and the lines an administrator reads before approving it: one per thing the
/// change adds or updates, warnings under the lines they belong to, and a count line last (empty when the policy
/// already has everything). <see cref="Notes"/> are lines that change nothing: for each app of the change that the policy
/// already had and that no write control protects, how to add the protection.</summary>
public sealed record PolicyChangeResult(string Json, IReadOnlyList<string> Summary)
{
    public IReadOnlyList<string> Notes { get; init; } = [];
}

/// <summary>
/// Merges a change file into the policy. A change is a JSON object with any of <c>allowedApps</c>,
/// <c>writeControls</c>, <c>gatedKeys</c>, <c>helperProcesses</c> and <c>clipboardRead</c>, in the policy file's own
/// shape. It only adds: lists are unioned, <c>clipboardRead</c> may only be <c>true</c>, and <c>maxFileBytes</c> and
/// unknown keys are refused. An <c>allowedApps</c> entry with the exe and path of an existing entry (case-insensitive)
/// is merged into it: a <c>sha256</c> sets or changes the pin (none keeps it), <c>allowedArgs</c> lists are added, and
/// <c>allowUserWritable</c> can be turned on but not off.
/// <para>
/// Two things a change may have that a policy file does not, both only for the question and never kept: a
/// <c>name</c> in a <c>writeControls</c> entry (the control's name as the recorder showed it), and
/// <c>leftOutControls</c>, the controls the recorder did not propose because their ids are those of Windows' standard
/// dialog buttons (OK, Cancel, Yes, No and the like): 1 to 11 in a classic dialog, CommandButton_1 to CommandButton_11
/// in a task dialog, which every dialog of an app shares. Such an entry with any other id is refused, so the line that
/// says why it was left out stays true.
/// </para>
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

    /// <summary>The longest row of a line the tool breaks itself; a longer line continues on the next row.</summary>
    public const int RowLength = 76;

    /// <summary>The most of a name or value that a refusal repeats.</summary>
    public const int MaxEchoLength = 60;

    private const string RowIndent = "        ";

    private const string NonAsciiWarning = @"WARNING: this line holds characters outside plain ASCII, shown as \u escapes";
    private const string SpacesWarning = "WARNING: a value in this line has leading, trailing or repeated spaces";
    private const string HelperWarning = "WARNING: any program at this path counts as part of the app that started it";

    /// <summary>Under the named write controls a change adds: what the runner then refuses (RunnerService's write gate).</summary>
    public const string ProtectMeaning = "A run must then mark a step as a write to press one of these, and to press any key but Tab, arrows, Home, End, " +
                                         "PageUp, PageDown or Escape while a window that holds one is open.";

    private const string LeftOutReason = ": 1 to 11 are the ids of Windows' standard dialog buttons, which every dialog of the app shares";
    private const string LeftOutTaskReason = ": CommandButton_1 to CommandButton_11 are the ids of the standard buttons of Windows' task dialogs, " +
                                             "which every task dialog of the app shares";
    private const string TaskButton = "CommandButton_";

    // The keys of a policy file and of the entries in its lists, as RunnerPolicy reads them.
    private static readonly string[] PolicyKeys = ["allowedApps", "writeControls", "gatedKeys", "maxFileBytes", "helperProcesses", "clipboardRead"];

    private static readonly Dictionary<string, string[]> EntryKeys = new()
    {
        ["allowedApps"] = ["exe", "path", "sha256", "allowedArgs", "allowUserWritable"],
        ["writeControls"] = ["exe", "automationId"],
        ["helperProcesses"] = ["exe", "pathPattern"],
    };

    // What a change may have beyond a policy file: names for the question, and the controls left out.
    private const string LeftOutKey = "leftOutControls";
    private static readonly string[] ChangeKeys = [.. PolicyKeys, LeftOutKey];

    private static readonly Dictionary<string, string[]> ChangeEntryKeys = new(EntryKeys)
    {
        ["writeControls"] = ["exe", "automationId", "name"],
        [LeftOutKey] = ["exe", "automationId", "name"],
    };

    /// <summary>Whether an automation id is one of Windows' standard dialog button ids, 1 to 11 (IDOK to IDCONTINUE),
    /// written as Windows writes them: as the number in a classic dialog, as CommandButton_ and the number in a task
    /// dialog ("Confirm Save As" names its Yes CommandButton_6). An app's own buttons in a task dialog have ids the app
    /// chooses. The recorder leaves such a control out (WriteRules.IsDialogButtonId, held to this).</summary>
    public static bool IsDialogButtonId(string automationId) => Regex.IsMatch(automationId, "^(?:CommandButton_)?(?:[1-9]|1[01])\\z");

    /// <summary>A control the change names: a write control with its name, or one left out.</summary>
    private sealed record NamedControl(string Exe, string AutomationId, string? Name);

    /// <summary>What a change holds for the question only, and the change without it, as RunnerPolicy reads it.</summary>
    private sealed record ChangeExtras(HashSet<int> WritableOff, List<NamedControl> Names, List<NamedControl> LeftOut, string PolicyJson);

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
        var extras = CheckChange(changeJson);
        var writableOff = extras.WritableOff;
        var change = RunnerPolicy.Parse(extras.PolicyJson, "the change");
        CheckSize(change, extras);

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
        bool Protected(string exe, string id) => writes.Any(w => Same(w.Exe, exe) && w.AutomationId == id);
        var named = 0;
        foreach (var write in change.WriteControls)
        {
            if (Protected(write.Exe, write.AutomationId)) continue;
            writes.Add(write);
            // A name from the recorder: the control as the person saw it, then its id.
            if (extras.Names.FirstOrDefault(n => Same(n.Exe, write.Exe) && n.AutomationId == write.AutomationId)?.Name is { } name)
            {
                Add("Protect {0} ({1}) of {2} as a write control", name, write.AutomationId, write.Exe);
                named++;
            }
            else Add("Add write control {0} / {1}", write.Exe, write.AutomationId);
        }
        if (named > 0) lines.Add(ProtectMeaning);
        var addedWrites = writes.Count - current.WriteControls.Count;
        var shownLeftOut = new List<NamedControl>();
        foreach (var left in extras.LeftOut)
        {
            if (Protected(left.Exe, left.AutomationId) || shownLeftOut.Any(s => Same(s.Exe, left.Exe) && s.AutomationId == left.AutomationId)) continue;
            shownLeftOut.Add(left);
            var reason = left.AutomationId.StartsWith(TaskButton, StringComparison.Ordinal) ? LeftOutTaskReason : LeftOutReason;
            if (left.Name is { } name) Add("Not protected: {0} ({1}) of {2}" + reason, name, left.AutomationId, left.Exe);
            else Add("Not protected: {0} of {1}" + reason, left.AutomationId, left.Exe);
        }

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
                    throw Refused($"a policy change cannot turn allowUserWritable off for {Echo(old.Path)}");
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

        // A left-out control alone changes nothing, and gets no question.
        if (changedApps + addedHelpers + addedWrites + addedKeys == 0 && !clipboardOn) lines.Clear();
        else
        {
            lines.Add($"This change: {changedApps} app(s) allowed or updated, {addedHelpers} helper process pattern(s), {addedWrites} write control(s), " +
                      $"{addedKeys} gated key(s){(clipboardOn ? ", clipboard read turned on" : "")}.");
        }

        // An app the policy had (allowed by an earlier version, for example) that no write control protects.
        var notes = change.AllowedApps.Select(a => a.Exe)
            .Where(exe => current.AllowedApps.Any(a => Same(a.Exe, exe)) && !writes.Any(w => Same(w.Exe, exe)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(exe => $"No write control is listed for {Literal(exe)}, so the runner gates no write in it. To protect its save or post buttons, " +
                           "record a run that clicks them and apply that recording's change file the same way.")
            .ToList();

        var json = JsonSerializer.Serialize(new FileOut(
            apps.Select(a => new AppOut(a.Exe, a.Path, a.Sha256, a.AllowedArgs.Count > 0 ? a.AllowedArgs : null, a.AllowUserWritable ? true : null)).ToList(),
            writes,
            keys.Select(k => k.ToString()).ToList(),
            current.MaxFileBytes,
            helpers.Count > 0 ? helpers.Select(h => new HelperOut(h.Exe, h.PathPattern)).ToList() : null,
            current.ClipboardRead || change.ClipboardRead ? true : null), OutOptions) + Environment.NewLine;
        RunnerPolicy.Parse(json, "the changed policy");
        return new PolicyChangeResult(json, lines) { Notes = notes };
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

    /// <summary>
    /// A name or value as a refusal repeats it: as a literal (<see cref="Literal"/>), and only its first
    /// <see cref="MaxEchoLength"/> characters, followed by three dots, when it is longer. The dots are plain ASCII:
    /// a console whose code page has no ellipsis character prints that character as a single dot.
    /// </summary>
    internal static string Echo(string value) =>
        value.Length <= MaxEchoLength ? Literal(value) : Literal(value[..MaxEchoLength]) + "...";

    /// <summary>
    /// The summary as it is printed, row by row: every line but the last in rows of at most <see cref="RowLength"/>
    /// characters (<see cref="Rows"/>). The last line, the count, holds nothing from the change and stays whole.
    /// </summary>
    public static IReadOnlyList<string> Printed(IReadOnlyList<string> summary) =>
        summary.Count == 0 ? [] : [.. summary.Take(summary.Count - 1).SelectMany(Rows), summary[^1]];

    /// <summary>
    /// One line as the rows it is printed in. The tool breaks a long line itself, so that a console does not do it
    /// and put the rest of a value at the left edge, where it could look like a line of the tool's. A row holds at
    /// most <see cref="RowLength"/> characters, and every row after the first starts with eight spaces.
    /// <para>
    /// The tool's own words are broken only after a space, so a word, a hash and the words a line starts with (up to
    /// the opening quote of its first value) each stay on one row. Inside a value (between its quotes) a break
    /// falls between characters of the printed text, with an escape (<c>\uXXXX</c>, <c>\"</c>, <c>\\</c>) kept
    /// whole, and not next to one of the value's spaces when that can be avoided inside the value (a space at the
    /// end of a row could not be seen). The rows put together without the eight spaces are the line.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<string> Rows(string line)
    {
        var pieces = Pieces(line);
        var rows = new List<string>();
        var indent = "";
        for (var start = 0; start < pieces.Count; indent = RowIndent)
        {
            var room = RowLength - indent.Length;
            var end = start;
            for (; end < pieces.Count && pieces[end].Text.Length <= room; end++) room -= pieces[end].Text.Length;
            var head = "";
            if (end < pieces.Count && pieces[end].Text.Length > RowLength - RowIndent.Length)
            {
                // A piece longer than any later row (a path without a space, for one): as much of it as fits here,
                // and not all of it but the spaces it ends with.
                var text = pieces[end].Text;
                var units = Units(text);
                var fit = 0;
                for (; fit < units.Count && head.Length + units[fit].Length <= room; fit++) head += units[fit];
                if (fit > 1 && string.IsNullOrWhiteSpace(text[head.Length..])) head = head[..^units[fit - 1].Length];
                pieces[end] = pieces[end] with { Text = text[head.Length..] };
            }
            else if (end < pieces.Count)
            {
                end = Break(pieces, start, end);
            }
            rows.Add(indent + string.Concat(pieces.GetRange(start, end - start).Select(piece => piece.Text)) + head);
            start = end;
        }
        return rows.Count > 0 ? rows : [""];
    }

    /// <summary>
    /// A stretch of a printed line that stays on one row. <paramref name="Opening"/> is the position of the opening
    /// quote of the value the piece belongs to (-1 for the tool's own text), and <paramref name="Inside"/> says the
    /// piece is one printed character of that value, between its quotes.
    /// </summary>
    private readonly record struct Piece(string Text, int Opening, bool Inside)
    {
        public bool ValueSpace => Inside && Text == " ";
    }

    /// <summary>
    /// The line in pieces: each word of the tool's own text with the spaces after it; and for each value its opening
    /// quote, its printed characters one by one (an escape is one), and its closing quote with the spaces after it.
    /// </summary>
    private static List<Piece> Pieces(string line)
    {
        var units = Units(line);
        var pieces = new List<Piece>();
        for (var at = 0; at < units.Count;)
        {
            var end = at;
            var close = units[at] == "\"" ? units.IndexOf("\"", at + 1) : -1;
            var opening = close < 0 ? -1 : pieces.Count;
            if (close >= 0)
            {
                pieces.Add(new Piece("\"", opening, Inside: false));
                for (at++; at < close; at++) pieces.Add(new Piece(units[at], opening, Inside: true));
                end = close + 1;
            }
            else
            {
                // A quote that no later quote closes is an ordinary character.
                while (end < units.Count && units[end] != " " && (units[end] != "\"" || end == at)) end++;
            }
            while (end < units.Count && units[end] == " ") end++;
            pieces.Add(new Piece(string.Concat(units.GetRange(at, end - at)), opening, Inside: false));
            at = end;
        }
        return pieces;
    }

    /// <summary>
    /// Where the row that starts at <paramref name="start"/> ends when the piece at <paramref name="end"/> no longer
    /// fits: before that piece, or, when that is next to a space of a value, at the nearest earlier place inside the
    /// same value that is not (at the earliest directly after the value's opening quote). When the value has no such
    /// place on this row, the row stays full and the break is among the spaces.
    /// </summary>
    private static int Break(List<Piece> pieces, int start, int end)
    {
        bool NextToSpace(int at) => pieces[at - 1].ValueSpace || pieces[at].ValueSpace;
        if (!NextToSpace(end)) return end;
        var opening = pieces[end - 1].ValueSpace ? pieces[end - 1].Opening : pieces[end].Opening;
        for (var at = end - 1; at > Math.Max(start, opening); at--)
        {
            if (!NextToSpace(at)) return at;
        }
        return end;
    }

    /// <summary>The printed text in pieces that stay on one row: single characters, and each escape as one piece.</summary>
    private static List<string> Units(string line)
    {
        var units = new List<string>();
        for (var at = 0; at < line.Length; at += units[^1].Length)
        {
            var length = line[at] != '\\' ? 1
                : at + 5 < line.Length && line[at + 1] == 'u' && line.AsSpan(at + 2, 4).IndexOfAnyExcept("0123456789ABCDEFabcdef") < 0 ? 6
                : Math.Min(2, line.Length - at);
            units.Add(line.Substring(at, length));
        }
        return units;
    }

    private static readonly JsonDocumentOptions DocumentOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>
    /// <see cref="RunnerPolicy.Parse"/> for a policy file the tool reads, after the tool's own look at the text
    /// (<see cref="CheckEntries"/>).
    /// </summary>
    internal static RunnerPolicy Parse(string json, string source)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json, DocumentOptions);
        }
        catch (JsonException e)
        {
            throw Refused($"{source}: {e.Message}");
        }
        using (document) CheckEntries(document.RootElement, source, change: false);
        return RunnerPolicy.Parse(json, source);
    }

    /// <summary>
    /// What the tool refuses in a policy text before the runner's parser reads it. The null entries and arguments
    /// that parser fails on without a message; and everything for which that parser's message would repeat a name or
    /// a value from the text as it is and at any length: an unknown key, a key chord it cannot read, and an entry
    /// without its path. Here such a name or value is repeated through <see cref="Echo"/>.
    /// </summary>
    private static void CheckEntries(JsonElement root, string source, bool change)
    {
        if (root.ValueKind != JsonValueKind.Object) return;
        // The two texts for a change that earlier rulings fixed carry no "the change: ".
        var entrySource = change ? "" : $"{source}: ";
        var (topKeys, entryKeys) = change ? (ChangeKeys, ChangeEntryKeys) : (PolicyKeys, EntryKeys);
        foreach (var property in root.EnumerateObject())
        {
            if (!topKeys.Contains(property.Name)) throw Refused($"{source}: unknown key {Echo(property.Name)}");
            if (property.Value.ValueKind != JsonValueKind.Array) continue;
            if (property.NameEquals("gatedKeys"))
            {
                foreach (var key in property.Value.EnumerateArray().Where(key => key.ValueKind == JsonValueKind.String).Select(key => key.GetString()!))
                {
                    try { KeyChord.Parse(key); }
                    catch (RpcException) { throw Refused($"{source}: gatedKeys has an invalid key chord {Echo(key)}"); }
                }
            }
            if (!entryKeys.TryGetValue(property.Name, out var keys)) continue;
            foreach (var entry in property.Value.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) throw Refused($"{entrySource}an entry in {property.Name} must be an object");
                if (entry.EnumerateObject().Select(p => p.Name).FirstOrDefault(name => !keys.Contains(name)) is { } unknown)
                    throw Refused($"{source}: unknown key {Echo(unknown)} in {property.Name}");
                var arguments = entry.EnumerateObject()
                    .Where(p => p.NameEquals("allowedArgs") && p.Value.ValueKind == JsonValueKind.Array)
                    .SelectMany(p => p.Value.EnumerateArray())
                    .Where(list => list.ValueKind == JsonValueKind.Array)
                    .SelectMany(list => list.EnumerateArray());
                if (arguments.Any(argument => argument.ValueKind != JsonValueKind.String)) throw Refused($"{entrySource}an allowed argument must be text");
                // The parser's own sentences for an entry without its path, which name the entry by its exe.
                if (!entry.TryGetProperty("exe", out var exe) || exe.ValueKind != JsonValueKind.String) continue;
                if (property.NameEquals("allowedApps") && Missing(entry, "path"))
                    throw Refused($"{source}: allowedApps[].path is required (the absolute path of {Echo(exe.GetString()!)})");
                if (property.NameEquals("helperProcesses") && Missing(entry, "pathPattern"))
                    throw Refused($"{source}: helperProcesses[].pathPattern is required (the absolute path of {Echo(exe.GetString()!)}, one folder written as *)");
            }
        }
    }

    private static bool Missing(JsonElement entry, string key) => !entry.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null;

    /// <summary>
    /// The rules a change has beyond a policy file's: no maxFileBytes, clipboardRead only true, and no short (8.3)
    /// name in a path, which would name an existing entry's file without being that entry. Returns the positions of
    /// the allowedApps entries that write <c>allowUserWritable: false</c>, which the parsed policy cannot tell from
    /// an entry that leaves it out; the names and the left-out controls (<see cref="ReadExtras"/>); and the change
    /// without them, for RunnerPolicy.
    /// </summary>
    private static ChangeExtras CheckChange(string changeJson)
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
            CheckEntries(document.RootElement, "the change", change: true);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.NameEquals("maxFileBytes")) throw Refused("the change: maxFileBytes cannot be changed by a change (edit the policy file)");
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
            var (names, leftOut) = ReadExtras(document.RootElement);
            var policyJson = changeJson;
            if (names.Count > 0 || document.RootElement.TryGetProperty(LeftOutKey, out _))
            {
                // What RunnerPolicy reads: the change without what is only for the question.
                var stripped = JsonNode.Parse(changeJson, documentOptions: DocumentOptions)!.AsObject();
                stripped.Remove(LeftOutKey);
                if (stripped["writeControls"] is JsonArray writes)
                {
                    foreach (var write in writes.OfType<JsonObject>()) write.Remove("name");
                }
                policyJson = stripped.ToJsonString();
            }
            return new ChangeExtras(writableOff, names, leftOut, policyJson);
        }
    }

    /// <summary>
    /// The names of a change's write controls, and its left-out controls: each with an exe (a file name) and an id of
    /// Windows' standard dialog buttons (<see cref="IsDialogButtonId"/>), and a name when it has one. A name is text.
    /// </summary>
    private static (List<NamedControl> Names, List<NamedControl> LeftOut) ReadExtras(JsonElement root)
    {
        static string? Text(JsonElement entry, string key) =>
            entry.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        static string? Name(JsonElement entry)
        {
            if (!entry.TryGetProperty("name", out var name)) return null;
            if (name.ValueKind != JsonValueKind.String) throw Refused("the change: a control's name must be text");
            return name.GetString();
        }
        var names = new List<NamedControl>();
        if (root.TryGetProperty("writeControls", out var writes) && writes.ValueKind == JsonValueKind.Array)
        {
            foreach (var write in writes.EnumerateArray())
            {
                if (Name(write) is { } name && Text(write, "exe") is { } exe && Text(write, "automationId") is { } id) names.Add(new NamedControl(exe, id, name));
            }
        }
        var leftOut = new List<NamedControl>();
        if (!root.TryGetProperty(LeftOutKey, out var left)) return (names, leftOut);
        if (left.ValueKind != JsonValueKind.Array) throw Refused($"the change: {LeftOutKey} must be a list");
        foreach (var entry in left.EnumerateArray())
        {
            var exe = Text(entry, "exe");
            var id = Text(entry, "automationId");
            if (string.IsNullOrWhiteSpace(exe) || exe.IndexOfAny(['\\', '/']) >= 0 || id is null) throw Refused($"the change: {LeftOutKey}[] needs exe and automationId");
            if (!IsDialogButtonId(id))
                throw Refused($"the change: {LeftOutKey} lists only the ids of Windows' standard dialog buttons (1 to 11, CommandButton_1 to CommandButton_11), not {Echo(id)}");
            leftOut.Add(new NamedControl(exe, id, Name(entry)));
        }
        return (names, leftOut);
    }

    private static void CheckFullPath(JsonElement entry, string key)
    {
        if (entry.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String) RefuseShortName(value.GetString()!);
    }

    /// <summary>Refuses a path that holds <c>~</c> followed by a digit, as a short (8.3) name does.</summary>
    internal static void RefuseShortName(string path)
    {
        if (Regex.IsMatch(path, "~[0-9]")) throw Refused($"write the full path, not a short (8.3) name: {Echo(path)}");
    }

    /// <summary>The limits on a change: its entries (a left-out control is one), the arguments in a list and the length
    /// of a value (a name is one).</summary>
    private static void CheckSize(RunnerPolicy change, ChangeExtras extras)
    {
        var lists = change.AllowedApps.SelectMany(a => a.AllowedArgs).ToList();
        var entries = change.AllowedApps.Count + lists.Count + change.WriteControls.Count + change.GatedKeys.Count + change.HelperProcesses.Count +
                      extras.LeftOut.Count;
        if (entries > MaxEntries) throw Refused($"a change may hold at most {MaxEntries} entries; this one holds {entries}");
        if (lists.Any(list => list.Count > MaxArguments)) throw Refused($"an allowed argument list may hold at most {MaxArguments} arguments");
        var values = change.AllowedApps.SelectMany(a => new[] { a.Exe, a.Path })
            .Concat(lists.SelectMany(list => list))
            .Concat(change.WriteControls.SelectMany(w => new[] { w.Exe, w.AutomationId }))
            .Concat(change.HelperProcesses.SelectMany(h => new[] { h.Exe, h.PathPattern }))
            .Concat(extras.Names.Concat(extras.LeftOut).SelectMany(c => new[] { c.Exe, c.AutomationId, c.Name ?? "" }));
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
