using Rpa.Runner.Core.Policy;

namespace Rpa.Runner.Core.Tests;

public class PolicyChangeTests
{
    // The policy takes only absolute local paths, so the paths are this platform's: on Windows the README's own.
    private static readonly string Root = OperatingSystem.IsWindows() ? @"C:\Program Files" : "/opt";
    private static readonly string ErpPath = Path.Combine(Root, "ERP Demo", "ErpDemo.exe");
    private static readonly string HelperPattern = Path.Combine(Root, "EdgeWebView", "Application", "*", "msedgewebview2.exe");
    private static readonly string ShaA = new('A', 64), ShaB = new('B', 64);
    private static string J(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    private const string NonAscii = @"WARNING: this line holds characters outside plain ASCII, shown as \u escapes";
    private const string HelperWarning = "WARNING: any program at this path counts as part of the app that started it";

    /// <summary>A plain ASCII value as the summary shows it: a JSON string literal.</summary>
    private static string L(string value) => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private static string Writable(string path) => $"WARNING: {L(path)} can be changed by the runner's own user";

    private static string Count(int apps = 0, int helpers = 0, int writes = 0, int keys = 0, bool clipboard = false) =>
        $"This change: {apps} app(s) allowed or updated, {helpers} helper process pattern(s), {writes} write control(s), {keys} gated key(s){(clipboard ? ", clipboard read turned on" : "")}.";

    private static string AppChange(string path, string more = "") =>
        $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(path)}}{{more}} }] }""";

    /// <summary>A policy with the ERP Demo entry and these options, e.g. <c>"sha256": "..."</c>.</summary>
    private static string Policy(string options = "") => PolicyChange.Apply("", AppChange(ErpPath, options == "" ? "" : ", " + options)).Json;

    private static (IReadOnlyList<string> Summary, RunnerPolicy.AllowedApp App) Merge(string current, string options)
    {
        var result = PolicyChange.Apply(current, AppChange(ErpPath, options == "" ? "" : ", " + options));
        return (result.Summary, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps));
    }

    private static void Refused(string current, string change, string message)
    {
        var e = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => PolicyChange.Apply(current, change));
        Assert.Equal(message, e.Message);
    }

    private static void RefusedWith(string current, string change, string part)
    {
        var e = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => PolicyChange.Apply(current, change));
        Assert.Contains(part, e.Message);
    }

    [Fact]
    public void Adds_an_app_to_an_empty_policy()
    {
        var result = PolicyChange.Apply("", AppChange(ErpPath));
        Assert.Equal([$"Allow app \"ErpDemo.exe\" at {L(ErpPath)}", Count(apps: 1)], result.Summary);
        if (OperatingSystem.IsWindows())
            Assert.Equal(@"Allow app ""ErpDemo.exe"" at ""C:\\Program Files\\ERP Demo\\ErpDemo.exe""", result.Summary[0]);
        var policy = RunnerPolicy.Parse(result.Json);
        var app = Assert.Single(policy.AllowedApps);
        Assert.Equal("ErpDemo.exe", app.Exe);
        Assert.Equal(ErpPath, app.Path);
        Assert.Equal(20971520, policy.MaxFileBytes);
    }

    [Fact]
    public void The_installer_s_starter_policy_is_accepted()
    {
        const string starter = """{ "allowedApps": [], "maxFileBytes": 20971520 }""";
        Assert.Empty(RunnerPolicy.Parse(starter).AllowedApps);
        var policy = RunnerPolicy.Parse(PolicyChange.Apply(starter, AppChange(ErpPath)).Json);
        Assert.Single(policy.AllowedApps);
        Assert.Equal(20971520, policy.MaxFileBytes);
    }

    [Fact]
    public void Keeps_the_current_policy_s_other_settings()
    {
        var current = $$"""
            { "allowedApps": [{ "exe": "Other.exe", "path": {{J(Path.Combine(Root, "Other", "Other.exe"))}}, "allowedArgs": [["--ui", "v2"]] }],
              "gatedKeys": ["Ctrl+S"], "maxFileBytes": 1048576, "clipboardRead": true }
            """;
        var policy = RunnerPolicy.Parse(PolicyChange.Apply(current, AppChange(ErpPath)).Json);
        Assert.Equal(["Other.exe", "ErpDemo.exe"], policy.AllowedApps.Select(a => a.Exe));
        Assert.Equal(["--ui", "v2"], Assert.Single(policy.AllowedApps[0].AllowedArgs));
        Assert.Equal(KeyChord.Parse("Ctrl+S"), Assert.Single(policy.GatedKeys));
        Assert.Equal(1048576, policy.MaxFileBytes);
        Assert.True(policy.ClipboardRead);
    }

    [Fact]
    public void Shows_the_hash_an_added_app_is_pinned_to()
    {
        var result = PolicyChange.Apply("", AppChange(ErpPath, $$""", "sha256": "{{ShaA.ToLowerInvariant()}}" """));
        Assert.Equal([$"Allow app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaA})", Count(apps: 1)], result.Summary);
        Assert.Equal(ShaA, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).Sha256);
    }

    [Fact]
    public void Merges_an_app_with_the_same_exe_and_path_into_the_existing_entry()
    {
        var current = Policy("""  "allowedArgs": [["--ui", "v1"]]""");
        var upper = Path.Combine(Root, "ERP Demo", "ERPDEMO.EXE");
        var change = $$"""{ "allowedApps": [{ "exe": "ERPDEMO.EXE", "path": {{J(upper)}}, "sha256": "{{ShaA}}" }] }""";
        var result = PolicyChange.Apply(current, change);
        Assert.Equal([$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaA})", Count(apps: 1)], result.Summary);
        var app = Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps);
        Assert.Equal(("ErpDemo.exe", ErpPath, ShaA), (app.Exe, app.Path, app.Sha256));
        Assert.Equal(["--ui", "v1"], Assert.Single(app.AllowedArgs));
    }

    [Fact]
    public void A_change_without_sha256_keeps_an_existing_pin()
    {
        var (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), """  "allowedArgs": [["--ui", "v2"]]""");
        Assert.Equal(
            [$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (allowed arguments added)", "  with arguments: \"--ui\" \"v2\"", Count(apps: 1)],
            summary);
        Assert.Equal(ShaA, app.Sha256);

        (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), "");
        Assert.Empty(summary);
        Assert.Equal(ShaA, app.Sha256);
    }

    [Fact]
    public void A_sha256_sets_or_changes_the_pin_and_the_line_shows_the_hashes()
    {
        var (summary, app) = Merge(Policy(), $"\"sha256\": \"{ShaA}\"");
        Assert.Equal([$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaA})", Count(apps: 1)], summary);
        Assert.Equal(ShaA, app.Sha256);

        (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), $"\"sha256\": \"{ShaB}\"");
        Assert.Equal([$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pin changed from {ShaA} to {ShaB})", Count(apps: 1)], summary);
        Assert.Equal(ShaB, app.Sha256);

        (summary, _) = Merge(Policy($"\"sha256\": \"{ShaA}\""), $"\"sha256\": \"{ShaA.ToLowerInvariant()}\"");
        Assert.Empty(summary);
    }

    [Fact]
    public void Argument_lists_are_unioned_without_duplicates()
    {
        var current = Policy("""  "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]]""");
        var (summary, app) = Merge(current, """  "allowedArgs": [["--ui", "v2"], ["v2", "--ui"], ["--ui"], ["--ui"], ["--UI", "v1"]]""");
        Assert.Equal(
            [
                $"Update app \"ErpDemo.exe\" at {L(ErpPath)} (allowed arguments added)",
                "  with arguments: \"v2\" \"--ui\"", "  with arguments: \"--ui\"", "  with arguments: \"--UI\" \"v1\"",
                Count(apps: 1),
            ],
            summary);
        Assert.Equal(["--ui v1", "--ui v2", "v2 --ui", "--ui", "--UI v1"], app.AllowedArgs.Select(list => string.Join(' ', list)));

        (summary, app) = Merge(current, """  "allowedArgs": [["--ui", "v2"], ["--ui", "v1"]]""");
        Assert.Empty(summary);
        Assert.Equal(2, app.AllowedArgs.Count);

        // A change without lists removes none.
        (summary, app) = Merge(current, "");
        Assert.Empty(summary);
        Assert.Equal(2, app.AllowedArgs.Count);
    }

    [Fact]
    public void AllowUserWritable_can_be_turned_on_but_not_off()
    {
        var (summary, app) = Merge(Policy(), """  "allowUserWritable": true""");
        Assert.Equal([$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (user-writable path allowed)", Writable(ErpPath), Count(apps: 1)], summary);
        Assert.True(app.AllowUserWritable);

        var writable = Policy("""  "allowUserWritable": true""");
        (summary, app) = Merge(writable, "");
        Assert.Empty(summary);
        Assert.True(app.AllowUserWritable);

        (summary, app) = Merge(writable, """  "allowUserWritable": true""");
        Assert.Empty(summary);
        Assert.True(app.AllowUserWritable);

        Refused(writable, AppChange(ErpPath, """, "allowUserWritable": false, "allowedArgs": [["--ui", "v1"]]"""),
            $"a policy change cannot turn allowUserWritable off for {ErpPath}");

        (summary, app) = Merge(Policy(), """  "allowUserWritable": false""");
        Assert.Empty(summary);
        Assert.False(app.AllowUserWritable);
    }

    [Fact]
    public void Every_line_for_a_user_writable_app_carries_the_warning_above_its_argument_lists()
    {
        var result = PolicyChange.Apply("", AppChange(ErpPath, """, "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]], "allowUserWritable": true"""));
        Assert.Equal(
            [
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}",
                Writable(ErpPath),
                "  with arguments: \"--ui\" \"v1\"",
                "  with arguments: \"--ui\" \"v2\"",
                Count(apps: 1),
            ],
            result.Summary);
        Assert.True(Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).AllowUserWritable);

        // An update that does not touch allowUserWritable still says the entry is user-writable.
        var (summary, _) = Merge(result.Json, $"\"sha256\": \"{ShaA}\"");
        Assert.Equal([$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaA})", Writable(ErpPath), Count(apps: 1)], summary);
    }

    [Fact]
    public void An_update_lists_everything_that_changes_in_order()
    {
        var current = Policy($"\"sha256\": \"{ShaA}\", \"allowedArgs\": [[\"--ui\", \"v1\"]]");
        var (summary, app) = Merge(current, $"\"allowUserWritable\": true, \"allowedArgs\": [[\"--ui\", \"v2\"]], \"sha256\": \"{ShaB}\"");
        Assert.Equal(
            [
                $"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pin changed from {ShaA} to {ShaB}; allowed arguments added; user-writable path allowed)",
                Writable(ErpPath),
                "  with arguments: \"--ui\" \"v2\"",
                Count(apps: 1),
            ],
            summary);
        Assert.Equal((ShaB, 2, true), (app.Sha256, app.AllowedArgs.Count, app.AllowUserWritable));

        (summary, _) = Merge(Policy(), $"\"sha256\": \"{ShaB}\", \"allowedArgs\": [[\"--ui\", \"v2\"]]");
        Assert.Equal(
            [$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaB}; allowed arguments added)", "  with arguments: \"--ui\" \"v2\"", Count(apps: 1)],
            summary);
    }

    [Fact]
    public void An_update_that_adds_one_list_prints_only_the_added_list()
    {
        var current = Policy("""  "allowedArgs": [["--ui", "v1"]]""");
        var (summary, app) = Merge(current, """  "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]]""");
        Assert.Equal(
            [$"Update app \"ErpDemo.exe\" at {L(ErpPath)} (allowed arguments added)", "  with arguments: \"--ui\" \"v2\"", Count(apps: 1)],
            summary);
        Assert.Equal(["--ui v1", "--ui v2"], app.AllowedArgs.Select(list => string.Join(' ', list)));
    }

    [Fact]
    public void An_app_listed_twice_in_one_change_is_added_then_merged()
    {
        var change = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowedArgs": [["--ui", "v1"]] },
                              { "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowedArgs": [["--ui", "v2"]] }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal(
            [
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}", "  with arguments: \"--ui\" \"v1\"",
                $"Update app \"ErpDemo.exe\" at {L(ErpPath)} (allowed arguments added)", "  with arguments: \"--ui\" \"v2\"",
                Count(apps: 2),
            ],
            result.Summary);
        Assert.Equal(2, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).AllowedArgs.Count);
    }

    [Fact]
    public void The_same_exe_at_another_path_is_another_app()
    {
        var current = PolicyChange.Apply("", AppChange(ErpPath)).Json;
        var second = Path.Combine(Root, "ERP Demo 2", "ErpDemo.exe");
        var result = PolicyChange.Apply(current, AppChange(second));
        Assert.Equal([$"Allow app \"ErpDemo.exe\" at {L(second)}", Count(apps: 1)], result.Summary);
        Assert.Equal([ErpPath, second], RunnerPolicy.Parse(result.Json).AllowedApps.Select(a => a.Path));
    }

    [Fact]
    public void Unions_write_controls_gated_keys_and_helper_processes_without_duplicates()
    {
        var current = $$"""
            { "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }], "gatedKeys": ["Ctrl+S"],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }] }
            """;
        var widgets = Path.Combine(Root, "Widgets", "*", "widgethost.exe");
        var change = $$"""
            { "writeControls": [{ "exe": "ERPDEMO.EXE", "automationId": "btnPost" }, { "exe": "ErpDemo.exe", "automationId": "btnDelete" },
                                { "exe": "ErpDemo.exe", "automationId": "btnDelete" }],
              "gatedKeys": ["ctrl+s", "F11", "f11"],
              "helperProcesses": [{ "exe": "MSEDGEWEBVIEW2.EXE", "pathPattern": {{J(HelperPattern.ToUpperInvariant())}} },
                                  { "exe": "widgethost.exe", "pathPattern": {{J(widgets)}} }] }
            """;
        var result = PolicyChange.Apply(current, change);
        Assert.Equal(
            [
                "Add write control \"ErpDemo.exe\" / \"btnDelete\"", "Add gated key \"F11\"",
                $"Add helper process \"widgethost.exe\" at {L(widgets)}", HelperWarning,
                Count(helpers: 1, writes: 1, keys: 1),
            ],
            result.Summary);
        var policy = RunnerPolicy.Parse(result.Json);
        Assert.Equal(["btnPost", "btnDelete"], policy.WriteControls.Select(w => w.AutomationId));
        Assert.Equal(["Ctrl+S", "F11"], policy.GatedKeys.Select(k => k.ToString()));
        Assert.Equal(["msedgewebview2.exe", "widgethost.exe"], policy.HelperProcesses.Select(h => h.Exe));
    }

    [Fact]
    public void Turns_on_clipboard_read()
    {
        var result = PolicyChange.Apply("{}", """{ "clipboardRead": true }""");
        Assert.Equal(["Turn on clipboard read", Count(clipboard: true)], result.Summary);
        Assert.True(RunnerPolicy.Parse(result.Json).ClipboardRead);
    }

    [Fact]
    public void Lines_that_tighten_come_first_then_lines_that_widen_and_the_count_is_last()
    {
        var second = Path.Combine(Root, "Other", "Other.exe");
        var change = $$"""
            { "clipboardRead": true,
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }],
              "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "sha256": "{{ShaA}}", "allowedArgs": [["--ui", "v1"], []], "allowUserWritable": true },
                              { "exe": "Other.exe", "path": {{J(second)}} }],
              "gatedKeys": ["ctrl+s", "F11"],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal(
            [
                "Add write control \"ErpDemo.exe\" / \"btnPost\"",
                "Add gated key \"Ctrl+S\"",
                "Add gated key \"F11\"",
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)} (SHA-256 pinned {ShaA})",
                Writable(ErpPath),
                "  with arguments: \"--ui\" \"v1\"",
                "  with arguments: (none)",
                $"Allow app \"Other.exe\" at {L(second)}",
                $"Add helper process \"msedgewebview2.exe\" at {L(HelperPattern)}",
                HelperWarning,
                "Turn on clipboard read",
                "This change: 2 app(s) allowed or updated, 1 helper process pattern(s), 1 write control(s), 2 gated key(s), clipboard read turned on.",
            ],
            result.Summary);
    }

    [Fact]
    public void The_same_change_twice_gives_an_empty_summary()
    {
        var change = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "sha256": "{{ShaB}}", "allowedArgs": [["--ui", "v1"]] }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }], "gatedKeys": ["Ctrl+S"],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }], "clipboardRead": true }
            """;
        var first = PolicyChange.Apply("", change);
        Assert.Equal(8, first.Summary.Count);
        var second = PolicyChange.Apply(first.Json, change);
        Assert.Empty(second.Summary);
        Assert.Equal(first.Json, second.Json);
    }

    [Fact]
    public void Shows_every_value_as_a_JSON_string_literal()
    {
        // A value cannot read as the tool's own words, as another path or as two arguments.
        var odd = Path.Combine(Root, "Apps", "x.exe (SHA-256 pinned)");
        var change = $$"""
            { "allowedApps": [{ "exe": "x.exe (SHA-256 pinned)", "path": {{J(odd)}}, "allowedArgs": [["a\" \"b", "", "C:\\Data\\My File.csv"]] }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "say \"hi\"" }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal(
            [
                """Add write control "ErpDemo.exe" / "say \"hi\"" """.TrimEnd(),
                $"Allow app \"x.exe (SHA-256 pinned)\" at {L(odd)}",
                """  with arguments: "a\" \"b" "" "C:\\Data\\My File.csv" """.TrimEnd(),
                Count(apps: 1, writes: 1),
            ],
            result.Summary);
    }

    [Fact]
    public void Shows_characters_outside_plain_ASCII_as_escapes_with_a_warning_under_the_line()
    {
        // A no-break space in a folder name, a line break and a cursor command in an id, an emoji (two UTF-16 units)
        // and a right-to-left override in arguments: all shown, none refused.
        var folder = Path.Combine(Root + "\u00a0Files", "ERP Demo", "ErpDemo.exe");
        var change = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(folder)}}, "allowedArgs": [["--ui", "v1"], ["\ud83d\ude00", "\u202ev2"]], "allowUserWritable": true }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost\nAllow app \"Harmless.exe\"\u001b[1A\t" }],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(Path.Combine(Root, "Édge", "*", "msedgewebview2.exe"))}} }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal(
            [
                """Add write control "ErpDemo.exe" / "btnPost\u000AAllow app \"Harmless.exe\"\u001B[1A\u0009" """.TrimEnd(),
                NonAscii,
                $"Allow app \"ErpDemo.exe\" at {L(folder).Replace("\u00a0", "\\u00A0")}",
                NonAscii,
                $"WARNING: {L(folder).Replace("\u00a0", "\\u00A0")} can be changed by the runner's own user",
                "  with arguments: \"--ui\" \"v1\"",
                """  with arguments: "\uD83D\uDE00" "\u202Ev2" """.TrimEnd(),
                NonAscii,
                $"Add helper process \"msedgewebview2.exe\" at {L(Path.Combine(Root, "Édge", "*", "msedgewebview2.exe")).Replace("É", "\\u00C9")}",
                NonAscii,
                HelperWarning,
                Count(apps: 1, helpers: 1, writes: 1),
            ],
            result.Summary);
        Assert.All(result.Summary, line => Assert.All(line, c => Assert.InRange(c, ' ', '~')));
        Assert.Equal(folder, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).Path);
    }

    [Fact]
    public void Refuses_a_change_with_more_than_40_entries()
    {
        static string Keys(int n) => $$"""{ "gatedKeys": [{{string.Join(", ", Enumerable.Repeat("\"F1\"", n))}}] }""";
        Assert.Equal(["Add gated key \"F1\"", Count(keys: 1)], PolicyChange.Apply("", Keys(40)).Summary);
        Refused("", Keys(41), "a change may hold at most 40 entries; this one holds 41");

        // Each allowed argument list is an entry: one app with 39 lists is 40, a write control more is 41.
        var lists = string.Join(", ", Enumerable.Range(0, 39).Select(i => $"[\"--page\", \"{i}\"]"));
        var app = $$"""  "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowedArgs": [{{lists}}] }]""";
        Assert.Equal(41, PolicyChange.Apply("", "{" + app + "}").Summary.Count);
        Refused("", "{" + app + """, "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }] }""",
            "a change may hold at most 40 entries; this one holds 41");
        Refused("", "{" + app + $$""", "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }] }""",
            "a change may hold at most 40 entries; this one holds 41");
    }

    [Fact]
    public void Refuses_an_argument_list_with_more_than_20_arguments()
    {
        static string Args(int n) => string.Join(", ", Enumerable.Range(0, n).Select(i => $"\"a{i}\""));
        var result = PolicyChange.Apply("", AppChange(ErpPath, $", \"allowedArgs\": [[{Args(20)}]]"));
        Assert.Equal("  with arguments: " + string.Join(' ', Enumerable.Range(0, 20).Select(i => $"\"a{i}\"")), result.Summary[1]);
        Refused("", AppChange(ErpPath, $", \"allowedArgs\": [[\"--ui\"], [{Args(21)}]]"), "an allowed argument list may hold at most 20 arguments");
        Refused(Policy(), AppChange(ErpPath, $", \"allowedArgs\": [[{Args(21)}]]"), "an allowed argument list may hold at most 20 arguments");
    }

    [Fact]
    public void Refuses_a_value_longer_than_260_characters()
    {
        static string Id(int n) => $$"""{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "{{new string('x', n)}}" }] }""";
        Assert.Equal(2, PolicyChange.Apply("", Id(260)).Summary.Count);
        Refused("", Id(261), "a value in the change is longer than 260 characters");

        var longName = new string('x', 257) + ".exe";
        string[] changes =
        [
            AppChange(ErpPath, $", \"allowedArgs\": [[\"--ui\", \"{new string('x', 261)}\"]]"),
            $$"""{ "allowedApps": [{ "exe": "{{longName}}", "path": {{J(Path.Combine(Root, longName))}} }] }""",
            $$"""{ "writeControls": [{ "exe": "{{longName}}", "automationId": "btnPost" }] }""",
            $$"""{ "helperProcesses": [{ "exe": "{{longName}}", "pathPattern": {{J(Path.Combine(Root, "*", longName))}} }] }""",
        ];
        foreach (var change in changes) Refused("", change, "a value in the change is longer than 260 characters");
    }

    [Fact]
    public void Refuses_a_short_8_3_name_in_a_path()
    {
        var shortPath = Path.Combine(Path.GetDirectoryName(Root)!, "PROGRA~1", "ERP Demo", "ErpDemo.exe");
        Refused("", AppChange(shortPath), $"write the full path, not a short (8.3) name: {L(shortPath)}");
        var shortFolder = Path.Combine(Root, "ERPDEM~2", "ErpDemo.exe");
        Refused(Policy(), AppChange(shortFolder), $"write the full path, not a short (8.3) name: {L(shortFolder)}");

        var shortPattern = Path.Combine(Root, "EDGEWE~1", "*", "msedgewebview2.exe");
        Refused("", $$"""{ "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(shortPattern)}} }] }""",
            $"write the full path, not a short (8.3) name: {L(shortPattern)}");

        // A tilde that is not followed by a digit is an ordinary character.
        var tilde = Path.Combine(Root, "~apps", "ErpDemo.exe");
        Assert.Equal(tilde, Assert.Single(RunnerPolicy.Parse(PolicyChange.Apply("", AppChange(tilde)).Json).AllowedApps).Path);
    }

    [Fact]
    public void Refuses_maxFileBytes() =>
        Refused("", """{ "maxFileBytes": 1048576 }""", "the change: maxFileBytes cannot be changed by a change (edit the policy file)");

    [Fact]
    public void Refuses_an_unknown_key() => Refused("", """{ "allowedApp": [] }""", "the change: unknown key \"allowedApp\"");

    [Fact]
    public void Refuses_clipboardRead_false() =>
        Refused("""{ "clipboardRead": true }""", """{ "clipboardRead": false }""", "the change: clipboardRead may only be true (a change only adds)");

    [Fact]
    public void Refuses_a_change_whose_result_the_runner_would_refuse() =>
        Refused("", AppChange(Path.Combine("apps", "ErpDemo.exe")), "the change: allowedApps[].path must be an absolute local path (no UNC or device paths)");

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("\"allowedApps\"")]
    [InlineData("5")]
    public void Refuses_a_change_that_is_not_a_JSON_object(string change) => Refused("", change, "the change: must be a JSON object");

    [Theory]
    [InlineData("not json")]
    [InlineData("")]
    [InlineData("{ \"allowedApps\": [")]
    public void Refuses_a_change_that_is_not_JSON(string change) => RefusedWith("", change, "the change: ");

    [Fact]
    public void Refuses_to_change_a_policy_the_runner_would_refuse() =>
        RefusedWith("""{ "allowedApp": [] }""", AppChange(ErpPath), "the current policy: ");

    [Fact]
    public void Writes_two_space_indented_camelCase_JSON_with_the_example_s_key_order()
    {
        var change = $$"""
            { "clipboardRead": true, "helperProcesses": [{ "pathPattern": {{J(HelperPattern)}}, "exe": "msedgewebview2.exe" }],
              "gatedKeys": ["ctrl+s"], "writeControls": [{ "automationId": "btnPost", "exe": "ErpDemo.exe" }],
              "allowedApps": [{ "allowUserWritable": true, "allowedArgs": [["--ui", "v1"]], "sha256": "{{new string('c', 64)}}", "path": {{J(ErpPath)}}, "exe": "ErpDemo.exe" }] }
            """;
        var json = PolicyChange.Apply("", change).Json;
        var lines = json.Split('\n').Select(l => l.TrimEnd('\r')).ToArray();
        Assert.Equal("{", lines[0]);
        Assert.Equal("  \"allowedApps\": [", lines[1]);
        Assert.Equal("    {", lines[2]);
        Assert.Equal("      \"exe\": \"ErpDemo.exe\",", lines[3]);
        Assert.Contains("  \"gatedKeys\": [", lines);
        Assert.Contains("    \"Ctrl+S\"", lines);
        Assert.EndsWith("}", json.TrimEnd());
        Assert.EndsWith("\n", json);
        string[] keys =
        [
            "\"allowedApps\"", "\"exe\"", "\"path\"", "\"sha256\"", "\"allowedArgs\"", "\"allowUserWritable\"",
            "\"writeControls\"", "\"automationId\"", "\"gatedKeys\"", "\"maxFileBytes\"", "\"helperProcesses\"",
            "\"pathPattern\"", "\"clipboardRead\"",
        ];
        var at = keys.Select(k => json.IndexOf(k, StringComparison.Ordinal)).ToArray();
        Assert.DoesNotContain(-1, at);
        Assert.Equal(at.Order(), at);
    }

    [Fact]
    public void Leaves_out_what_an_entry_does_not_set()
    {
        var json = PolicyChange.Apply("", AppChange(ErpPath)).Json;
        foreach (var key in new[] { "sha256", "allowedArgs", "allowUserWritable", "helperProcesses", "clipboardRead" })
            Assert.DoesNotContain(key, json);
        foreach (var key in new[] { "allowedApps", "writeControls", "gatedKeys", "maxFileBytes" })
            Assert.Contains(key, json);
    }
}
