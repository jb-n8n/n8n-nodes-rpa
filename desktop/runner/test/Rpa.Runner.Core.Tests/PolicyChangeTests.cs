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
    private const string Spaces = "WARNING: a value in this line has leading, trailing or repeated spaces";

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
    public void The_install_guides_sample_change_is_accepted()
    {
        // docs/install/samples/erp-demo-policy-change.json, the change the Windows guide has an administrator apply. Its
        // path is the installed demo's under Program Files; elsewhere than on Windows it is moved under this platform's
        // root, as the policy takes only absolute local paths.
        var root = typeof(PolicyChangeTests).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
            .Cast<System.Reflection.AssemblyMetadataAttribute>().Single(a => a.Key == "RepoRoot").Value!;
        var sample = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(root, "docs", "install", "samples", "erp-demo-policy-change.json")))!;
        const string Installed = @"C:\Program Files\RPA Runner\erp-demo\v1\ErpDemo.exe";
        Assert.Equal(Installed, sample["allowedApps"]![0]!["path"]!.GetValue<string>());
        var path = OperatingSystem.IsWindows() ? Installed : Path.Combine(Root, "RPA Runner", "erp-demo", "v1", "ErpDemo.exe");
        sample["allowedApps"]![0]!["path"] = path;

        var result = PolicyChange.Apply("""{ "allowedApps": [], "maxFileBytes": 20971520 }""", sample.ToJsonString());
        Assert.DoesNotContain(result.Summary, line => line.StartsWith("WARNING", StringComparison.Ordinal));
        var policy = RunnerPolicy.Parse(result.Json);
        Assert.Equal(("ErpDemo.exe", path), (Assert.Single(policy.AllowedApps).Exe, policy.AllowedApps[0].Path));
        Assert.Equal(new RunnerPolicy.WriteControl("ErpDemo.exe", "btnPost"), Assert.Single(policy.WriteControls));
        Assert.Equal(["Ctrl+S", "F11"], policy.GatedKeys.Select(k => k.ToString()));
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
            $"a policy change cannot turn allowUserWritable off for {L(ErpPath)}");

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
        // Values that imitate the tool's own words, hold a quote or hold a space: each is shown inside quotes, with
        // its own quotes escaped.
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
    public void Warns_under_a_line_whose_value_has_leading_trailing_or_repeated_spaces()
    {
        // A space is printable, so it is shown as it is. A value padded to the width of the window puts what follows
        // the spaces at the start of the next row, where it can look like a line of the tool's.
        var padded = "btnPost" + new string(' ', 60) + "Allow app \"Harmless.exe\"";
        var pattern = Path.Combine(Root, "Edge  WebView", "*", "msedgewebview2.exe");
        var change = $$"""
            { "writeControls": [{ "exe": "ErpDemo.exe", "automationId": {{J(padded)}} }, { "exe": "ErpDemo.exe", "automationId": " lead" },
                                { "exe": "ErpDemo.exe", "automationId": "trail " }, { "exe": "ErpDemo.exe", "automationId": "one space" }],
              "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowUserWritable": true,
                                "allowedArgs": [["--ui", "a  b"], ["plain", "x y"], [" "], ["\u00a0  x"]] }],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(pattern)}} }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal(
            [
                $"Add write control \"ErpDemo.exe\" / \"btnPost{new string(' ', 60)}Allow app \\\"Harmless.exe\\\"\"",
                Spaces,
                "Add write control \"ErpDemo.exe\" / \" lead\"",
                Spaces,
                "Add write control \"ErpDemo.exe\" / \"trail \"",
                Spaces,
                "Add write control \"ErpDemo.exe\" / \"one space\"",
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}",
                Writable(ErpPath),
                "  with arguments: \"--ui\" \"a  b\"",
                Spaces,
                "  with arguments: \"plain\" \"x y\"",
                "  with arguments: \" \"",
                Spaces,
                "  with arguments: \"\\u00A0  x\"",
                NonAscii,
                Spaces,
                $"Add helper process \"msedgewebview2.exe\" at {L(pattern)}",
                Spaces,
                HelperWarning,
                Count(apps: 1, helpers: 1, writes: 4),
            ],
            result.Summary);
    }

    private static string Control(string id) => $$"""{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": {{J(id)}} }] }""";

    // The start of a write control line up to its id: 35 characters, so 41 more fill a row of 76.
    private const string ControlStart = "Add write control \"ErpDemo.exe\" / \"";

    [Fact]
    public void A_long_line_is_printed_in_rows_of_76_characters_that_continue_after_eight_spaces()
    {
        Assert.Equal(35, ControlStart.Length);
        var result = PolicyChange.Apply("", Control(new string('x', 100)));
        Assert.Equal([$"{ControlStart}{new string('x', 100)}\"", Count(writes: 1)], result.Summary);
        Assert.Equal(
            [
                $"{ControlStart}{new string('x', 41)}",
                $"        {new string('x', 59)}\"",
                Count(writes: 1),
            ],
            PolicyChange.Printed(result.Summary));

        // A line of exactly 76 characters is one row; one more character is a second row.
        Assert.Equal([$"{ControlStart}{new string('x', 40)}\"", Count(writes: 1)], PolicyChange.Printed(PolicyChange.Apply("", Control(new string('x', 40))).Summary));
        Assert.Equal(
            [$"{ControlStart}{new string('x', 41)}", "        \"", Count(writes: 1)],
            PolicyChange.Printed(PolicyChange.Apply("", Control(new string('x', 41))).Summary));
    }

    [Fact]
    public void A_value_of_260_characters_of_words_is_wrapped_and_every_later_row_starts_with_eight_spaces()
    {
        // 52 words with single spaces between them: no spaces warning, and nothing the old checks would notice.
        var value = string.Join(' ', Enumerable.Range(10, 52).Select(i => $"w{i}x")) + "y";
        Assert.Equal(260, value.Length);
        var result = PolicyChange.Apply("", Control(value));
        Assert.Equal(2, result.Summary.Count);

        var rows = PolicyChange.Printed(result.Summary);
        var line = rows.Take(rows.Count - 1).ToList();
        Assert.Equal(5, line.Count);
        Assert.StartsWith($"{ControlStart}w10x w11x ", line[0]);
        Assert.All(line.Take(4), row => Assert.InRange(row.Length, 70, 76));
        Assert.InRange(line[4].Length, 10, 76);
        Assert.All(line.Skip(1), row =>
        {
            Assert.StartsWith("        ", row);
            Assert.NotEqual(' ', row[8]);
        });
        // No row ends with a space, so the rows put together, without the eight spaces, are the line.
        Assert.All(line, row => Assert.NotEqual(' ', row[^1]));
        Assert.Equal(result.Summary[0], line[0] + string.Concat(line.Skip(1).Select(row => row[8..])));
        Assert.Equal(Count(writes: 1), rows[^1]);
    }

    [Fact]
    public void Words_of_the_tool_s_inside_a_value_are_printed_on_rows_that_start_with_eight_spaces()
    {
        // Each id is cut so that a console 76 or 80 columns wide would have put the words at the left edge.
        var change = $$"""
            { "writeControls": [{ "exe": "ErpDemo.exe", "automationId": {{J(new string('x', 41) + "WARNING: nothing to see here")}} },
                                { "exe": "ErpDemo.exe", "automationId": {{J(new string('y', 45) + "Allow app \"Harmless.exe\" at \"C:\\Windows\\Harmless.exe\"")}} },
                                { "exe": "ErpDemo.exe", "automationId": {{J(new string('z', 41) + "This change: 0 app(s) allowed or updated, 0 helper process pattern(s), 0 write control(s), 0 gated key(s).")}} }] }
            """;
        var result = PolicyChange.Apply("", change);
        var rows = PolicyChange.Printed(result.Summary);
        Assert.Equal(
            [
                $"{ControlStart}{new string('x', 41)}",
                "        WARNING: nothing to see here\"",
                $"{ControlStart}{new string('y', 41)}",
                "        yyyyAllow app \\\"Harmless.exe\\\" at \\\"C:\\\\Windows\\\\Harmless.exe\\\"\"",
                $"{ControlStart}{new string('z', 41)}",
                "        This change: 0 app(s) allowed or updated, 0 helper process pattern(s",
                "        ), 0 write control(s), 0 gated key(s).\"",
                Count(writes: 3),
            ],
            rows);

        // Every row is the start of one of the tool's lines or begins with eight spaces; the faked words are only on
        // rows of the second kind.
        Assert.Equal(result.Summary.Count, rows.Count(row => !row.StartsWith("        ", StringComparison.Ordinal)));
        string[] faked = ["WARNING:", "Allow app", "This change:"];
        Assert.All(rows.Take(rows.Count - 1).Where(row => faked.Any(row.Contains)), row => Assert.StartsWith("        ", row));
        Assert.Equal(Count(writes: 3), Assert.Single(rows, row => row.StartsWith("This change:", StringComparison.Ordinal)));
    }

    [Fact]
    public void An_escape_at_the_end_of_a_row_is_kept_whole()
    {
        // The row has room for 76 characters; the escape would start before the end and finish after it.
        IReadOnlyList<string> Rows(string id) => PolicyChange.Printed(PolicyChange.Apply("", Control(id)).Summary);

        foreach (var before in new[] { 36, 39, 40 })
        {
            Assert.Equal(
                [$"{ControlStart}{new string('x', before)}", "        \\u00A0tail\"", NonAscii, Count(writes: 1)],
                Rows(new string('x', before) + "\u00a0tail"));
        }
        Assert.Equal([$"{ControlStart}{new string('x', 35)}\\u00A0", "        tail\"", NonAscii, Count(writes: 1)], Rows(new string('x', 35) + "\u00a0tail"));

        Assert.Equal([$"{ControlStart}{new string('x', 40)}", "        \\\"t\"", Count(writes: 1)], Rows(new string('x', 40) + "\"t"));
        Assert.Equal([$"{ControlStart}{new string('x', 40)}", "        \\\\t\"", Count(writes: 1)], Rows(new string('x', 40) + "\\t"));
        Assert.Equal([$"{ControlStart}{new string('x', 39)}\\\\", "        t\"", Count(writes: 1)], Rows(new string('x', 39) + "\\t"));
        // A backslash followed by text that looks like an escape is two characters and then plain text.
        Assert.Equal([$"{ControlStart}{new string('x', 38)}\\\\u", "        00A0\"", Count(writes: 1)], Rows(new string('x', 38) + "\\u00A0"));
    }

    [Fact]
    public void A_row_is_not_broken_next_to_a_space_when_that_can_be_avoided()
    {
        IReadOnlyList<string> Rows(string id) => PolicyChange.Printed(PolicyChange.Apply("", Control(id)).Summary);

        // A space as the last character of the row, or as the first of the next, could not be seen. The break moves back.
        Assert.Equal([$"{ControlStart}{new string('x', 39)}", "        x yyy\"", Count(writes: 1)], Rows(new string('x', 40) + " yyy"));
        Assert.Equal([$"{ControlStart}{new string('x', 40)}", "        x yyy\"", Count(writes: 1)], Rows(new string('x', 41) + " yyy"));
        Assert.Equal([$"{ControlStart}{new string('x', 41)}", "        x yyy\"", Count(writes: 1)], Rows(new string('x', 42) + " yyy"));

        // A run of spaces that fits in a row is kept on one row.
        Assert.Equal(
            [ControlStart, $"        a{new string(' ', 60)}b\"", Spaces, Count(writes: 1)],
            Rows("a" + new string(' ', 60) + "b"));

        // More spaces than a row holds: the row is full and the break is among them. The spaces warning is under the line.
        Assert.Equal(
            [ControlStart, $"        a{new string(' ', 67)}", $"        {new string(' ', 33)}b\"", Spaces, Count(writes: 1)],
            Rows("a" + new string(' ', 100) + "b"));
    }

    [Fact]
    public void Lines_under_an_app_keep_their_start_and_wrap_the_same_way()
    {
        var path = Path.Combine(Root, new string('d', 60), "ErpDemo.exe");
        var change = $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(path)}}, "sha256": "{{ShaA}}", "allowUserWritable": true, "allowedArgs": [["{{new string('a', 80)}}", "b"]] }] }""";
        var result = PolicyChange.Apply("", change);
        var rows = PolicyChange.Printed(result.Summary);
        Assert.All(rows.Take(rows.Count - 1), row => Assert.InRange(row.Length, 1, 76));
        // The tool's lines start at the left edge, the argument line after two spaces; everything else after eight.
        string[] starts = ["Allow app \"ErpDemo.exe\" at \"", "WARNING: \"", "  with arguments: \"aaaa", "This change: 1 app(s)"];
        Assert.Equal(starts.Length, rows.Count(row => !row.StartsWith("        ", StringComparison.Ordinal)));
        Assert.All(starts, start => Assert.Single(rows, row => row.StartsWith(start, StringComparison.Ordinal)));
        Assert.Equal($"  with arguments: \"{new string('a', 57)}", rows.Single(row => row.StartsWith("  with", StringComparison.Ordinal)));
        Assert.Contains($"        {new string('a', 23)}\" \"b\"", rows);
    }

    [Fact]
    public void The_words_a_line_starts_with_stay_on_its_first_row_up_to_the_opening_quote()
    {
        // Values that start with more spaces than a row holds: the break cannot avoid the spaces. It stays inside the
        // value, after the opening quote, and does not move back into the tool's own words.
        var spaces = new string(' ', 70);
        var name = spaces + "h.exe";
        var change = $$"""
            { "writeControls": [{ "exe": {{J(spaces + "x")}}, "automationId": "btnPost" }],
              "allowedApps": [{ "exe": {{J(name)}}, "path": {{J(Path.Combine(Root, name))}}, "allowedArgs": [[{{J(spaces + "x")}}]] }],
              "helperProcesses": [{ "exe": {{J(name)}}, "pathPattern": {{J(Path.Combine(Root, "*", name))}} }] }
            """;
        var result = PolicyChange.Apply("", change);
        var rows = PolicyChange.Printed(result.Summary);
        Assert.Contains("Add write control \"" + new string(' ', 57), rows);
        Assert.Contains("Allow app \"" + new string(' ', 65), rows);
        Assert.Contains("  with arguments: \"" + new string(' ', 57), rows);
        Assert.Contains("Add helper process \"" + new string(' ', 56), rows);
        // Every row is the start of a line or begins with eight spaces.
        Assert.Equal(result.Summary.Count, rows.Count(row => !row.StartsWith("        ", StringComparison.Ordinal)));
        Assert.All(rows.Take(rows.Count - 1), row => Assert.InRange(row.Length, 1, 76));
    }

    /// <summary>The rows of one line, and the places in the line where a row ends.</summary>
    private static (IReadOnlyList<string> Rows, List<int> Breaks) Broken(string line)
    {
        IReadOnlyList<string> rows = PolicyChange.Rows(line).ToList();
        Assert.All(rows, row => Assert.InRange(row.Length, 1, 76));
        Assert.All(rows.Skip(1), row => Assert.StartsWith("        ", row));
        Assert.Equal(line, rows[0] + string.Concat(rows.Skip(1).Select(row => row[8..])));
        var breaks = new List<int>();
        var at = 0;
        foreach (var row in rows.Take(rows.Count - 1))
        {
            at += row.Length - (breaks.Count == 0 ? 0 : 8);
            breaks.Add(at);
        }
        return (rows, breaks);
    }

    [Fact]
    public void The_tool_s_own_words_are_broken_only_after_a_space()
    {
        // The words after a value, for every length of path that moves them along the row.
        var after = 0;
        for (var length = 1; length <= 70; length++)
        {
            var line = Writable(Path.Combine(Root, new string('d', length), "ErpDemo.exe"));
            var (_, breaks) = Broken(line);
            var closing = line.LastIndexOf('"');
            foreach (var at in breaks.Where(at => at > closing + 1))
            {
                Assert.Equal(' ', line[at - 1]);
                after++;
            }
        }
        Assert.InRange(after, 20, int.MaxValue);

        // A line that was printed with "user" cut in two before this rule.
        Assert.Equal(
            [$"WARNING: \"{new string('p', 26)}\" can be changed by the runner's own ", "        user"],
            PolicyChange.Rows($"WARNING: \"{new string('p', 26)}\" can be changed by the runner's own user"));

        // A warning that is the tool's own words from start to end.
        Assert.Equal([HelperWarning], PolicyChange.Rows(HelperWarning));
        Assert.Equal(
            ["Update app \"ErpDemo.exe\" at \"x\" (allowed arguments added; user-writable ", "        path allowed)"],
            PolicyChange.Rows("Update app \"ErpDemo.exe\" at \"x\" (allowed arguments added; user-writable path allowed)"));
    }

    [Fact]
    public void A_hash_is_printed_whole_on_one_row()
    {
        for (var length = 1; length <= 70; length++)
        {
            var path = Path.Combine(Root, new string('d', length), "ErpDemo.exe");
            var pinned = PolicyChange.Apply("", AppChange(path, $", \"sha256\": \"{ShaA}\""));
            var rows = PolicyChange.Printed(pinned.Summary);
            Assert.Single(rows, row => row.Contains(ShaA));
            Assert.Equal(pinned.Summary.Count, rows.Count(row => !row.StartsWith("        ", StringComparison.Ordinal)));

            rows = PolicyChange.Printed(PolicyChange.Apply(pinned.Json, AppChange(path, $", \"sha256\": \"{ShaB}\", \"allowedArgs\": [[\"--ui\"]]")).Summary);
            Assert.Single(rows, row => row.Contains(ShaA));
            Assert.Single(rows, row => row.Contains(ShaB));
            Assert.All(rows.Take(rows.Count - 1), row => Assert.InRange(row.Length, 1, 76));
        }

        // A hash that does not fit in what is left of a row starts the next row.
        Assert.Equal(
            [$"Allow app \"ErpDemo.exe\" at \"{new string('p', 30)}\" (SHA-256 pinned ", $"        {ShaA})"],
            PolicyChange.Rows($"Allow app \"ErpDemo.exe\" at \"{new string('p', 30)}\" (SHA-256 pinned {ShaA})"));
        Assert.Equal(
            [$"Update app \"ErpDemo.exe\" at \"{new string('p', 30)}\" (SHA-256 pin ", "        changed from ", $"        {ShaA} to ", $"        {ShaB}; ", "        allowed arguments added)"],
            PolicyChange.Rows($"Update app \"ErpDemo.exe\" at \"{new string('p', 30)}\" (SHA-256 pin changed from {ShaA} to {ShaB}; allowed arguments added)"));
    }

    [Fact]
    public void A_refusal_repeats_a_name_or_a_value_as_a_literal_cut_to_60_characters()
    {
        // The mark of a cut is three plain dots: a console with a code page that has no ellipsis prints that
        // character as a single dot, which reads as the end of the sentence.
        var k60 = new string('k', 60);
        Refused("", $$"""{ "{{k60}}": 1 }""", $"the change: unknown key \"{k60}\"");
        Refused("", $$"""{ "{{k60}}k": 1 }""", $"the change: unknown key \"{k60}\"...");
        Refused("", $$"""{ "{{new string('k', 200_000)}}": 1 }""", $"the change: unknown key \"{k60}\"...");
        Refused("", """{ "café \"x\" 😀": 1 }""", "the change: unknown key \"caf\\u00E9 \\\"x\\\" \\uD83D\\uDE00\"");

        // A key the entries of a list do not have.
        Refused("", AppChange(ErpPath, $", \"{k60}k\": 1"), $"the change: unknown key \"{k60}\"... in allowedApps");
        Refused("", """{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost", "id": 1 }] }""", "the change: unknown key \"id\" in writeControls");
        Refused("", $$"""{ "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}}, "path": 1 }] }""", "the change: unknown key \"path\" in helperProcesses");

        // A key chord the runner cannot read.
        Refused("", $$"""{ "gatedKeys": ["Ctrl+{{new string('q', 70)}}"] }""", $"the change: gatedKeys has an invalid key chord \"Ctrl+{new string('q', 55)}\"...");
        Refused("", """{ "gatedKeys": ["Ctrl+Nope\u001b"] }""", "the change: gatedKeys has an invalid key chord \"Ctrl+Nope\\u001B\"");

        // An entry without its path, which the parser names by its exe.
        var longExe = new string('e', 70) + ".exe";
        Refused("", $$"""{ "allowedApps": [{ "exe": "{{longExe}}" }] }""", $"the change: allowedApps[].path is required (the absolute path of \"{new string('e', 60)}\"...)");
        Refused("", """{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": null }] }""", "the change: allowedApps[].path is required (the absolute path of \"ErpDemo.exe\")");
        Refused("", $$"""{ "helperProcesses": [{ "exe": "{{longExe}}" }] }""",
            $"the change: helperProcesses[].pathPattern is required (the absolute path of \"{new string('e', 60)}\"..., one folder written as *)");

        // A path the tool itself refuses.
        var shortPath = Path.Combine(Root, "ERPDEM~1", new string('d', 300), "ErpDemo.exe");
        Refused("", AppChange(shortPath), $"write the full path, not a short (8.3) name: {L(shortPath[..60])}...");
        var writable = Path.Combine(Root, new string('w', 80), "ErpDemo.exe");
        Refused(PolicyChange.Apply("", AppChange(writable, ", \"allowUserWritable\": true")).Json, AppChange(writable, ", \"allowUserWritable\": false"),
            $"a policy change cannot turn allowUserWritable off for {L(writable[..60])}...");

        // The same in the policy file the change is merged into.
        Refused($$"""{ "{{k60}}k": 1 }""", AppChange(ErpPath), $"the current policy: unknown key \"{k60}\"...");
        Refused($$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "{{k60}}k": 1 }] }""", AppChange(ErpPath), $"the current policy: unknown key \"{k60}\"... in allowedApps");
        Refused("""{ "gatedKeys": ["Ctrl+Nope"] }""", AppChange(ErpPath), "the current policy: gatedKeys has an invalid key chord \"Ctrl+Nope\"");
        Refused("""{ "allowedApps": [{ "exe": "ErpDemo.exe" }] }""", AppChange(ErpPath), "the current policy: allowedApps[].path is required (the absolute path of \"ErpDemo.exe\")");
    }

    [Fact]
    public void The_tool_knows_every_key_the_runner_s_parser_reads()
    {
        // The tool refuses an unknown key itself (the parser's message would repeat the key as it is). Its lists
        // must hold every key of the parser's shapes, or it would refuse a policy the runner takes.
        static IEnumerable<string> Keys(string shape) => typeof(RunnerPolicy).GetNestedType(shape, System.Reflection.BindingFlags.NonPublic)!
            .GetProperties().Select(property => System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(property.Name));

        Assert.Equal(6, Keys("FileShape").Count());
        foreach (var key in Keys("FileShape")) PolicyChange.Parse($$"""{ "{{key}}": null }""", "policy");
        (string List, string Shape)[] lists = [("allowedApps", "AppShape"), ("writeControls", "WriteShape"), ("helperProcesses", "HelperShape")];
        foreach (var (list, shape) in lists)
        {
            Assert.NotEmpty(Keys(shape));
            foreach (var key in Keys(shape))
            {
                var e = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => PolicyChange.Parse($$"""{ "{{list}}": [{ "{{key}}": null }] }""", "policy"));
                Assert.DoesNotContain("unknown key", e.Message);
            }
        }
        // The example policy passes whole.
        var example = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "sha256": "{{ShaA}}", "allowedArgs": [["--ui", "v1"]], "allowUserWritable": true }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }], "gatedKeys": ["Ctrl+S", "F11"], "maxFileBytes": 20971520,
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }], "clipboardRead": true }
            """;
        Assert.Equal(2, PolicyChange.Parse(example, "policy").GatedKeys.Count);
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

    [Theory]
    [InlineData("allowedApps")]
    [InlineData("writeControls")]
    [InlineData("helperProcesses")]
    public void Refuses_an_entry_that_is_not_an_object(string key)
    {
        foreach (var entry in new[] { "null", "5", "\"x\"", "[]" })
        {
            Refused("", $$"""{ "{{key}}": [{{entry}}] }""", $"an entry in {key} must be an object");
            Refused($$"""{ "{{key}}": [{{entry}}] }""", AppChange(ErpPath), $"the current policy: an entry in {key} must be an object");
        }
    }

    [Fact]
    public void Refuses_an_argument_that_is_not_text()
    {
        foreach (var argument in new[] { "null", "5", "true", "[]", "{}" })
        {
            Refused("", AppChange(ErpPath, $", \"allowedArgs\": [[\"--ui\", {argument}]]"), "an allowed argument must be text");
            Refused(Policy(), AppChange(ErpPath, $", \"allowedArgs\": [[\"--ui\", \"v1\"], [{argument}]]"), "an allowed argument must be text");
            Refused(AppChange(ErpPath, $", \"allowedArgs\": [[{argument}]]"), AppChange(ErpPath), "the current policy: an allowed argument must be text");
        }
    }

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

    /// <summary>The sample output in desktop/README.md ("Changing the policy") is in the rows the tool prints.</summary>
    [Fact]
    public void The_sample_output_in_the_README_is_wrapped_as_the_tool_wraps_it()
    {
        var folder = new DirectoryInfo(AppContext.BaseDirectory);
        while (folder is not null && !File.Exists(Path.Combine(folder.FullName, "Rpa.Desktop.sln"))) folder = folder.Parent;
        Assert.NotNull(folder);
        var readme = File.ReadAllLines(Path.Combine(folder.FullName, "README.md"));
        var first = Array.FindIndex(readme, l => l.StartsWith("# Allow app \"ErpDemo.exe\" at ", StringComparison.Ordinal));
        var count = Array.FindIndex(readme, l => l.StartsWith("# This change: 1 app(s) allowed or updated", StringComparison.Ordinal));
        Assert.True(first > 0 && count > first, "the sample is in the README");
        var shown = readme[first..count].Select(l => l[2..].TrimEnd()).ToArray();

        const string line = """Allow app "ErpDemo.exe" at "C:\\Program Files\\ERP Demo\\ErpDemo.exe" (SHA-256 pinned 3A7F5C1E9B2D4F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8)""";
        Assert.Equal(PolicyChange.Rows(line).Select(row => row.TrimEnd()), shown);
    }

    // The recorder's change file: the buttons its recording clicked that look like writes, each with the name it showed,
    // and the standard dialog buttons it left out.
    private const string Protects = "A run must then mark a step as a write to press one of these, and to press any key but Tab, arrows, Home, End, PageUp, PageDown or Escape while a window that holds one is open.";
    private static string RecorderChange(string writes, string leftOut = "") =>
        $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}} }], "writeControls": [{{writes}}]{{(leftOut == "" ? "" : $", \"leftOutControls\": [{leftOut}]")}} }""";
    private const string PostButton = """{ "exe": "ErpDemo.exe", "automationId": "btnPost", "name": "Post" }""";
    private const string SaveButton = """{ "exe": "ErpDemo.exe", "automationId": "1", "name": "Save" }""";
    private const string LeftOutSave = "Not protected: \"Save\" (\"1\") of \"ErpDemo.exe\": 1 to 11 are the ids of Windows' standard dialog buttons, which every dialog of the app shares";
    private const string BotsBefore = "Bots of \"ErpDemo.exe\" approved earlier stop where they press one of these buttons, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape while a window that holds one is open, unless that step was ticked as a write. Sign such a bot again on the import form with that step ticked.";
    private const string LeftOutTaskYes = "Not protected: \"Yes\" (\"CommandButton_6\") of \"ErpDemo.exe\": CommandButton_1 to CommandButton_11 are the ids of the standard buttons of Windows' task dialogs, which every task dialog of the app shares";

    [Fact]
    public void A_named_write_control_is_shown_as_a_button_to_protect_and_the_name_is_not_kept()
    {
        var result = PolicyChange.Apply("", RecorderChange(PostButton + """, { "exe": "ErpDemo.exe", "automationId": "btnDelete", "name": "Delete" }""", SaveButton));
        Assert.Equal(
            [
                "Protect \"Post\" (\"btnPost\") of \"ErpDemo.exe\" as a write control",
                "Protect \"Delete\" (\"btnDelete\") of \"ErpDemo.exe\" as a write control",
                Protects,
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}",
                LeftOutSave,
                Count(apps: 1, writes: 2),
            ],
            result.Summary);
        Assert.Empty(result.Notes);
        var policy = RunnerPolicy.Parse(result.Json);
        Assert.Equal([("ErpDemo.exe", "btnPost"), ("ErpDemo.exe", "btnDelete")], policy.WriteControls.Select(w => (w.Exe, w.AutomationId)));
        Assert.DoesNotContain("\"name\"", result.Json);
        Assert.DoesNotContain("leftOutControls", result.Json);
        Assert.DoesNotContain("Save", result.Json);
    }

    [Fact]
    public void A_write_control_without_a_name_keeps_its_line_and_a_policy_file_takes_no_name_and_no_left_out_list()
    {
        var result = PolicyChange.Apply("", """{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }] }""");
        Assert.Equal(["Add write control \"ErpDemo.exe\" / \"btnPost\"", Count(writes: 1)], result.Summary);
        // The names and the left-out list are for the question only: the policy file has neither.
        Refused($$"""{ "writeControls": [{{PostButton}}] }""", "{}", "the current policy: unknown key \"name\" in writeControls");
        Refused($$"""{ "leftOutControls": [{{SaveButton}}] }""", "{}", "the current policy: unknown key \"leftOutControls\"");
        Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => RunnerPolicy.Parse($$"""{ "writeControls": [{{PostButton}}] }"""));
    }

    [Fact]
    public void A_left_out_control_is_shown_once_and_never_applied_and_not_when_the_policy_protects_it()
    {
        var result = PolicyChange.Apply("", RecorderChange(PostButton, SaveButton + ", " + SaveButton + """, { "exe": "ErpDemo.exe", "automationId": "2" }"""));
        Assert.Equal(
            [
                "Protect \"Post\" (\"btnPost\") of \"ErpDemo.exe\" as a write control", Protects,
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}", LeftOutSave,
                "Not protected: \"2\" of \"ErpDemo.exe\": 1 to 11 are the ids of Windows' standard dialog buttons, which every dialog of the app shares",
                Count(apps: 1, writes: 1),
            ],
            result.Summary);
        Assert.Equal(["btnPost"], RunnerPolicy.Parse(result.Json).WriteControls.Select(w => w.AutomationId));

        // An administrator protected 1 by hand: the line would not be true.
        var current = """{ "writeControls": [{ "exe": "ERPDEMO.EXE", "automationId": "1" }] }""";
        Assert.DoesNotContain(PolicyChange.Apply(current, RecorderChange(PostButton, SaveButton)).Summary, line => line.StartsWith("Not protected", StringComparison.Ordinal));
        // Nothing else to change: a left-out control alone changes nothing.
        Assert.Empty(PolicyChange.Apply(PolicyChange.Apply("", RecorderChange(PostButton)).Json, RecorderChange(PostButton, SaveButton)).Summary);
    }

    [Fact]
    public void A_task_dialog_s_standard_button_is_named_as_left_out_with_its_own_reason()
    {
        // "Confirm Save As" (a task dialog) names its Yes CommandButton_6, the same in every task dialog of the app.
        var result = PolicyChange.Apply("", RecorderChange("", SaveButton + """, { "exe": "ErpDemo.exe", "automationId": "CommandButton_6", "name": "Yes" }"""));
        Assert.Equal(
            [
                // What is allowed comes first, what is left out last: the question does not open with "Not protected".
                $"Allow app \"ErpDemo.exe\" at {L(ErpPath)}",
                LeftOutSave,
                LeftOutTaskYes,
                Count(apps: 1),
            ],
            result.Summary);
        Assert.Empty(RunnerPolicy.Parse(result.Json).WriteControls);
        Assert.True(PolicyChange.IsDialogButtonId("CommandButton_1"));
        Assert.True(PolicyChange.IsDialogButtonId("CommandButton_11"));
        Assert.False(PolicyChange.IsDialogButtonId("CommandButton_12"));
        Assert.False(PolicyChange.IsDialogButtonId("CommandButton_101"));
        Assert.False(PolicyChange.IsDialogButtonId("CommandButton_06"));
        Assert.False(PolicyChange.IsDialogButtonId("commandbutton_6"));
        Assert.False(PolicyChange.IsDialogButtonId("CommandLink_6"));
    }

    [Theory]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "btnSave" }""", "the change: leftOutControls lists only the ids of Windows' standard dialog buttons (1 to 11, CommandButton_1 to CommandButton_11), not \"btnSave\"")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "12" }""", "the change: leftOutControls lists only the ids of Windows' standard dialog buttons (1 to 11, CommandButton_1 to CommandButton_11), not \"12\"")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "01" }""", "the change: leftOutControls lists only the ids of Windows' standard dialog buttons (1 to 11, CommandButton_1 to CommandButton_11), not \"01\"")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "CommandButton_100" }""", "the change: leftOutControls lists only the ids of Windows' standard dialog buttons (1 to 11, CommandButton_1 to CommandButton_11), not \"CommandButton_100\"")]
    [InlineData("""{ "exe": "ErpDemo.exe" }""", "the change: leftOutControls[] needs exe and automationId")]
    [InlineData("""{ "automationId": "1" }""", "the change: leftOutControls[] needs exe and automationId")]
    [InlineData("""{ "exe": "C:\\ErpDemo.exe", "automationId": "1" }""", "the change: leftOutControls[] needs exe and automationId")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": 1 }""", "the change: leftOutControls[] needs exe and automationId")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "1", "name": 5 }""", "the change: a control's name must be text")]
    [InlineData("""{ "exe": "ErpDemo.exe", "automationId": "1", "reason": "x" }""", "the change: unknown key \"reason\" in leftOutControls")]
    public void Refuses_a_left_out_control_the_line_would_say_something_untrue_about(string entry, string message) =>
        Refused("", RecorderChange(PostButton, entry), message);

    [Fact]
    public void Refuses_a_name_that_is_not_text_and_counts_the_left_out_controls_and_the_names_in_the_limits()
    {
        Refused("", RecorderChange("""{ "exe": "ErpDemo.exe", "automationId": "btnPost", "name": ["Post"] }"""), "the change: a control's name must be text");
        Refused("", RecorderChange($$"""{ "exe": "ErpDemo.exe", "automationId": "btnPost", "name": "{{new string('x', 261)}}" }"""),
            "a value in the change is longer than 260 characters");
        Refused("", RecorderChange(PostButton, $$"""{ "exe": "ErpDemo.exe", "automationId": "1", "name": "{{new string('x', 261)}}" }"""),
            "a value in the change is longer than 260 characters");
        // The app, one write control and 38 left-out controls are 40; one more is 41.
        var left = string.Join(", ", Enumerable.Repeat(SaveButton, 38));
        Assert.NotEmpty(PolicyChange.Apply("", RecorderChange(PostButton, left)).Summary);
        Refused("", RecorderChange(PostButton, left + ", " + SaveButton), "a change may hold at most 40 entries; this one holds 41");
    }

    [Fact]
    public void An_app_the_policy_has_without_write_controls_gets_a_note_on_how_to_protect_them_later()
    {
        // An app allowed by an earlier version: its entry has no write control. The runner gates no write in it.
        var earlier = Policy();
        var note = "No write control is listed for \"ErpDemo.exe\", so the runner gates no write in it. To protect its save or post buttons, record a run that clicks them and apply that recording's change file the same way.";
        var again = PolicyChange.Apply(earlier, AppChange(ErpPath));
        Assert.Empty(again.Summary);
        Assert.Equal([note], again.Notes);
        Assert.Equal([note], PolicyChange.Apply(earlier, AppChange(ErpPath, $", \"sha256\": \"{ShaA}\"")).Notes);

        // A recording that clicked Post adds the protection; no note then, and none once the policy has it.
        var protectedNow = PolicyChange.Apply(earlier, RecorderChange(PostButton));
        Assert.Equal(["Protect \"Post\" (\"btnPost\") of \"ErpDemo.exe\" as a write control", Protects, BotsBefore, Count(writes: 1)], protectedNow.Summary);
        Assert.Empty(protectedNow.Notes);
        Assert.Empty(PolicyChange.Apply(protectedNow.Json, AppChange(ErpPath)).Notes);
        // A new app gets none: its question says what it allows.
        Assert.Empty(PolicyChange.Apply("", AppChange(ErpPath)).Notes);
    }

    [Fact]
    public void Protecting_buttons_of_an_app_the_policy_already_allowed_says_what_happens_to_the_bots_approved_before()
    {
        // The app was allowed (bots of it may exist): the question says they stop where they press a protected button.
        var earlier = Policy();
        var result = PolicyChange.Apply(earlier, RecorderChange(PostButton, SaveButton));
        Assert.Equal(["Protect \"Post\" (\"btnPost\") of \"ErpDemo.exe\" as a write control", Protects, BotsBefore, LeftOutSave, Count(writes: 1)], result.Summary);
        // Without a name the line is the same (the protection is); it names the app as the policy spells it.
        Assert.Equal(["Add write control \"erpdemo.exe\" / \"btnPost\"", BotsBefore, Count(writes: 1)],
            PolicyChange.Apply(earlier, """{ "writeControls": [{ "exe": "erpdemo.exe", "automationId": "btnPost" }] }""").Summary);
        // A further button of an app that already has one: bots approved earlier may press it.
        var more = PolicyChange.Apply(result.Json, RecorderChange("""{ "exe": "ErpDemo.exe", "automationId": "btnDelete", "name": "Delete" }"""));
        Assert.Contains(BotsBefore, more.Summary);

        // A new app has no bots yet; nothing protected, nothing said; another app's buttons say nothing of this one.
        Assert.DoesNotContain(BotsBefore, PolicyChange.Apply("", RecorderChange(PostButton)).Summary);
        Assert.DoesNotContain(BotsBefore, PolicyChange.Apply(earlier, RecorderChange("", SaveButton)).Summary);
        Assert.DoesNotContain(BotsBefore, PolicyChange.Apply(result.Json, RecorderChange(PostButton)).Summary);
        Assert.Equal(["Add write control \"Other.exe\" / \"btnPost\"", Count(writes: 1)],
            PolicyChange.Apply(earlier, """{ "writeControls": [{ "exe": "Other.exe", "automationId": "btnPost" }] }""").Summary);
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
