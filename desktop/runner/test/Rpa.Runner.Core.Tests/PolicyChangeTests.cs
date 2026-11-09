using Rpa.Runner.Core.Policy;

namespace Rpa.Runner.Core.Tests;

public class PolicyChangeTests
{
    // The policy takes only absolute local paths, so the paths are this platform's: on Windows the README's own.
    private static readonly string Root = OperatingSystem.IsWindows() ? @"C:\Program Files" : "/opt";
    private static readonly string ErpPath = Path.Combine(Root, "ERP Demo", "ErpDemo.exe");
    private static readonly string HelperPattern = Path.Combine(Root, "EdgeWebView", "Application", "*", "msedgewebview2.exe");
    private static string J(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    private static string AppChange(string path, string more = "") =>
        $$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(path)}}{{more}} }] }""";

    private static void Refused(string current, string change, string expected)
    {
        var e = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => PolicyChange.Apply(current, change));
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void Adds_an_app_to_an_empty_policy()
    {
        var result = PolicyChange.Apply("", AppChange(ErpPath));
        Assert.Equal([$"Allow app ErpDemo.exe at {ErpPath}"], result.Summary);
        if (OperatingSystem.IsWindows())
            Assert.Equal([@"Allow app ErpDemo.exe at C:\Program Files\ERP Demo\ErpDemo.exe"], result.Summary);
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
    public void Says_when_an_added_app_is_pinned_to_its_hash()
    {
        var sha = new string('a', 64);
        var result = PolicyChange.Apply("", AppChange(ErpPath, $$""", "sha256": "{{sha}}" """));
        Assert.Equal([$"Allow app ErpDemo.exe at {ErpPath} (SHA-256 pinned)"], result.Summary);
        Assert.Equal(sha.ToUpperInvariant(), Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).Sha256);
    }

    private static readonly string ShaA = new string('A', 64), ShaB = new string('B', 64);

    /// <summary>A policy with the ERP Demo entry and these options, e.g. <c>"sha256": "..."</c>.</summary>
    private static string Policy(string options = "") => PolicyChange.Apply("", AppChange(ErpPath, options == "" ? "" : ", " + options)).Json;

    private static (IReadOnlyList<string> Summary, RunnerPolicy.AllowedApp App) Merge(string current, string options)
    {
        var result = PolicyChange.Apply(current, AppChange(ErpPath, options == "" ? "" : ", " + options));
        return (result.Summary, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps));
    }

    [Fact]
    public void Merges_an_app_with_the_same_exe_and_path_into_the_existing_entry()
    {
        var current = Policy("""  "allowedArgs": [["--ui", "v1"]]""");
        var upper = Path.Combine(Root, "ERP Demo", "ERPDEMO.EXE");
        var change = $$"""{ "allowedApps": [{ "exe": "ERPDEMO.EXE", "path": {{J(upper)}}, "sha256": "{{ShaA}}" }] }""";
        var result = PolicyChange.Apply(current, change);
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (SHA-256 pinned)"], result.Summary);
        if (OperatingSystem.IsWindows())
            Assert.Equal([@"Update app ErpDemo.exe at C:\Program Files\ERP Demo\ErpDemo.exe (SHA-256 pinned)"], result.Summary);
        var app = Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps);
        Assert.Equal(("ErpDemo.exe", ErpPath, ShaA), (app.Exe, app.Path, app.Sha256));
        Assert.Equal(["--ui", "v1"], Assert.Single(app.AllowedArgs));
    }

    [Fact]
    public void A_change_without_sha256_keeps_an_existing_pin()
    {
        var (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), """  "allowedArgs": [["--ui", "v2"]]""");
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (allowed arguments added)"], summary);
        Assert.Equal(ShaA, app.Sha256);

        (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), "");
        Assert.Empty(summary);
        Assert.Equal(ShaA, app.Sha256);
    }

    [Fact]
    public void A_sha256_sets_or_changes_the_pin()
    {
        var (summary, app) = Merge(Policy(), $"\"sha256\": \"{ShaA}\"");
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (SHA-256 pinned)"], summary);
        Assert.Equal(ShaA, app.Sha256);

        (summary, app) = Merge(Policy($"\"sha256\": \"{ShaA}\""), $"\"sha256\": \"{ShaB}\"");
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (SHA-256 pin changed)"], summary);
        Assert.Equal(ShaB, app.Sha256);

        (summary, _) = Merge(Policy($"\"sha256\": \"{ShaA}\""), $"\"sha256\": \"{ShaA.ToLowerInvariant()}\"");
        Assert.Empty(summary);
    }

    [Fact]
    public void Argument_lists_are_unioned_without_duplicates()
    {
        var current = Policy("""  "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]]""");
        var (summary, app) = Merge(current, """  "allowedArgs": [["--ui", "v2"], ["v2", "--ui"], ["--ui"], ["--ui"], ["--UI", "v1"]]""");
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (allowed arguments added)"], summary);
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
        Assert.Equal(
            [$"Update app ErpDemo.exe at {ErpPath} (user-writable path allowed)", $"WARNING: {ErpPath} can be changed by the runner's own user"],
            summary);
        Assert.True(app.AllowUserWritable);

        var writable = Policy("""  "allowUserWritable": true""");
        (summary, app) = Merge(writable, "");
        Assert.Empty(summary);
        Assert.True(app.AllowUserWritable);

        (summary, app) = Merge(writable, """  "allowUserWritable": true""");
        Assert.Empty(summary);
        Assert.True(app.AllowUserWritable);

        var e = Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => Merge(writable, """  "allowUserWritable": false, "allowedArgs": [["--ui", "v1"]]"""));
        Assert.Equal($"a policy change cannot turn allowUserWritable off for {ErpPath}", e.Message);

        (summary, app) = Merge(Policy(), """  "allowUserWritable": false""");
        Assert.Empty(summary);
        Assert.False(app.AllowUserWritable);
    }

    [Fact]
    public void An_update_lists_everything_that_changes_in_order()
    {
        var current = Policy($"\"sha256\": \"{ShaA}\", \"allowedArgs\": [[\"--ui\", \"v1\"]]");
        var (summary, app) = Merge(current, $"\"allowUserWritable\": true, \"allowedArgs\": [[\"--ui\", \"v2\"]], \"sha256\": \"{ShaB}\"");
        Assert.Equal(
            [
                $"Update app ErpDemo.exe at {ErpPath} (SHA-256 pin changed; allowed arguments added; user-writable path allowed)",
                $"WARNING: {ErpPath} can be changed by the runner's own user",
            ],
            summary);
        Assert.Equal((ShaB, 2, true), (app.Sha256, app.AllowedArgs.Count, app.AllowUserWritable));

        (summary, _) = Merge(Policy(), $"\"sha256\": \"{ShaB}\", \"allowedArgs\": [[\"--ui\", \"v2\"]]");
        Assert.Equal([$"Update app ErpDemo.exe at {ErpPath} (SHA-256 pinned; allowed arguments added)"], summary);
    }

    [Fact]
    public void An_app_listed_twice_in_one_change_is_added_then_merged()
    {
        var change = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowedArgs": [["--ui", "v1"]] },
                              { "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "allowedArgs": [["--ui", "v2"]] }] }
            """;
        var result = PolicyChange.Apply("", change);
        Assert.Equal([$"Allow app ErpDemo.exe at {ErpPath}", $"Update app ErpDemo.exe at {ErpPath} (allowed arguments added)"], result.Summary);
        Assert.Equal(2, Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).AllowedArgs.Count);
    }

    [Fact]
    public void The_same_exe_at_another_path_is_another_app()
    {
        var current = PolicyChange.Apply("", AppChange(ErpPath)).Json;
        var second = Path.Combine(Root, "ERP Demo 2", "ErpDemo.exe");
        var result = PolicyChange.Apply(current, AppChange(second));
        Assert.Equal([$"Allow app ErpDemo.exe at {second}"], result.Summary);
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
            ["Add write control ErpDemo.exe / btnDelete", "Add gated key F11", $"Add helper process widgethost.exe at {widgets}"],
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
        Assert.Equal(["Turn on clipboard read"], result.Summary);
        Assert.True(RunnerPolicy.Parse(result.Json).ClipboardRead);
    }

    [Fact]
    public void The_same_change_twice_gives_an_empty_summary()
    {
        var change = $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(ErpPath)}}, "sha256": "{{new string('b', 64)}}", "allowedArgs": [["--ui", "v1"]] }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }], "gatedKeys": ["Ctrl+S"],
              "helperProcesses": [{ "exe": "msedgewebview2.exe", "pathPattern": {{J(HelperPattern)}} }], "clipboardRead": true }
            """;
        var first = PolicyChange.Apply("", change);
        Assert.Equal(5, first.Summary.Count);
        var second = PolicyChange.Apply(first.Json, change);
        Assert.Empty(second.Summary);
        Assert.Equal(first.Json, second.Json);
    }

    [Fact]
    public void Refuses_maxFileBytes() => Refused("", """{ "maxFileBytes": 1048576 }""", "maxFileBytes");

    [Fact]
    public void Refuses_an_unknown_key() => Refused("", """{ "allowedApp": [] }""", "\"allowedApp\"");

    [Fact]
    public void Refuses_clipboardRead_false() => Refused("""{ "clipboardRead": true }""", """{ "clipboardRead": false }""", "clipboardRead");

    [Fact]
    public void Refuses_a_change_whose_result_the_runner_would_refuse() =>
        Refused("", AppChange(Path.Combine("apps", "ErpDemo.exe")), "allowedApps[].path must be an absolute local path");

    [Theory]
    [InlineData("not json")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("null")]
    public void Refuses_a_change_that_is_not_a_JSON_object(string change) => Refused("", change, "the change");

    [Fact]
    public void Refuses_to_change_a_policy_the_runner_would_refuse() =>
        Refused("""{ "allowedApp": [] }""", AppChange(ErpPath), "the current policy");

    [Fact]
    public void Refuses_text_that_could_hide_or_fake_a_summary_line()
    {
        foreach (var id in new[] { "btnPost\nAllow app Harmless.exe", "btnPost\u001b[1A\u001b[2K", "btnPost\u202e" })
            Refused("", $$"""{ "writeControls": [{ "exe": "ErpDemo.exe", "automationId": {{J(id)}} }] }""", "control characters");
    }

    [Fact]
    public void Warns_for_allowUserWritable()
    {
        var result = PolicyChange.Apply("", AppChange(ErpPath, """, "allowUserWritable": true"""));
        Assert.Equal(
            [$"Allow app ErpDemo.exe at {ErpPath}", $"WARNING: {ErpPath} can be changed by the runner's own user"],
            result.Summary);
        Assert.True(Assert.Single(RunnerPolicy.Parse(result.Json).AllowedApps).AllowUserWritable);
    }

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
