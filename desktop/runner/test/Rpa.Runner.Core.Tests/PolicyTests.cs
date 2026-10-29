using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Tests;

public class PolicyTests
{
    private static readonly string Pinned = Path.Combine(Path.GetTempPath(), "erp", "ErpDemo.exe");
    private static string J(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    private static readonly string Example = $$"""
        { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(Pinned)}} }],
          "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }],
          "gatedKeys": ["Ctrl+S", "F11"], "maxFileBytes": 20971520 }
        """;

    [Fact]
    public void Parses_the_contract_example_with_a_pinned_path()
    {
        var p = RunnerPolicy.Parse(Example);
        Assert.True(p.IsAllowedExe("erpdemo.EXE"));
        Assert.False(p.IsAllowedExe("notepad.exe"));
        Assert.True(p.IsWriteControl("ERPDEMO.exe", "btnPost"));
        Assert.False(p.IsWriteControl("ErpDemo.exe", "BTNPOST"));
        Assert.False(p.IsWriteControl("Other.exe", "btnPost"));
        Assert.True(p.IsGatedKey(KeyChord.Parse("ctrl+s")));
        Assert.True(p.IsGatedKey(KeyChord.Parse("f11")));
        Assert.True(p.IsGatedKey(KeyChord.Parse("Ctrl+Shift+S"))); // extra modifiers are gated too
        Assert.False(p.IsGatedKey(KeyChord.Parse("Shift+S")));
        Assert.Equal(20971520, p.MaxFileBytes);
        var app = Assert.Single(p.AllowedApps);
        Assert.False(app.AllowUserWritable);
        Assert.Empty(app.AllowedArgs);
    }

    [Fact]
    public void Defaults_the_file_limit_and_empty_lists()
    {
        var p = RunnerPolicy.Parse("{}");
        Assert.Equal(RunnerPolicy.DefaultMaxFileBytes, p.MaxFileBytes);
        Assert.Empty(p.AllowedApps);
    }

    [Theory]
    [InlineData("""{ "allowedApp": [] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "/opt/erp/ErpDemo.exe", "signer": "x" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "C:\\apps\\ErpDemo.exe", "path": "/opt/erp/ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "relative/ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "/opt/erp/Other.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "\\\\server\\share\\ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "//server/share/ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "\\\\?\\C:\\ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "/opt/erp/ErpDemo.exe", "sha256": "abc" }] }""")]
    [InlineData("""{ "writeControls": [{ "exe": "ErpDemo.exe" }] }""")]
    [InlineData("""{ "gatedKeys": ["Ctrl+Banana"] }""")]
    [InlineData("""{ "maxFileBytes": 0 }""")]
    [InlineData("""{ "maxFileBytes": 1073741824 }""")]
    [InlineData("""not json""")]
    public void Refuses_invalid_policies(string json)
    {
        Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => RunnerPolicy.Parse(json));
    }

    [Fact]
    public void Launch_refuses_apps_not_in_the_list()
    {
        var p = RunnerPolicy.Parse(Example);
        var e = Assert.Throws<RpcException>(() => p.ResolveLaunch("/opt/apps/notepad.exe", []));
        Assert.Equal(RpcErrors.PolicyRefusedCode, e.Code);
        Assert.Contains("notepad.exe", e.Message);
    }

    [Fact]
    public void Launch_starts_only_the_pinned_path()
    {
        var p = RunnerPolicy.Parse(Example);
        Assert.Equal(Pinned, p.ResolveLaunch("ErpDemo.exe", []).Path);
        Assert.Equal(Pinned, p.ResolveLaunch(Pinned, []).Path);
        foreach (var other in new[] { Path.Combine(Path.GetTempPath(), "evil", "ErpDemo.exe"), "apps/ErpDemo.exe", @"\\server\share\ErpDemo.exe", "//server/share/ErpDemo.exe" })
            Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch(other, [])).Code);
    }

    [Fact]
    public void Several_pinned_paths_for_one_exe()
    {
        var v1 = Path.Combine(Path.GetTempPath(), "v1", "ErpDemo.exe");
        var v2 = Path.Combine(Path.GetTempPath(), "v2", "ErpDemo.exe");
        var p = RunnerPolicy.Parse($$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(v1)}} }, { "exe": "ErpDemo.exe", "path": {{J(v2)}} }] }""");
        Assert.Equal(v1, p.ResolveLaunch("ErpDemo.exe", []).Path);
        Assert.Equal(v2, p.ResolveLaunch(v2, []).Path);
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch(Path.Combine(Path.GetTempPath(), "v3", "ErpDemo.exe"), [])).Code);
    }

    [Fact]
    public void Arguments_must_be_an_allowed_list_exactly()
    {
        var p = RunnerPolicy.Parse($$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{J(Pinned)}}, "allowedArgs": [["--ui", "v2"], ["--ui", "v1"]] }] }""");
        Assert.Equal(Pinned, p.ResolveLaunch("ErpDemo.exe", ["--ui", "v2"]).Path);
        Assert.Equal(Pinned, p.ResolveLaunch("ErpDemo.exe", []).Path);
        foreach (var args in new[] { new[] { "--ui" }, ["v2", "--ui"], ["--ui", "v2", "--evil"], ["--UI", "v2"] })
            Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch("ErpDemo.exe", args)).Code);
        var none = RunnerPolicy.Parse(Example);
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => none.ResolveLaunch("ErpDemo.exe", ["--ui", "v2"])).Code);
    }
}

public class ProcessAncestryTests
{
    private sealed class Scripted : Rpa.Runner.Core.Ui.SystemProcessHost
    {
        public Dictionary<int, (int Parent, DateTime Start)> Table { get; } = [];
        public override int? GetParentPid(int pid) => Table.TryGetValue(pid, out var t) ? t.Parent : null;
        protected override DateTime? GetStartTime(int pid) => Table.TryGetValue(pid, out var t) ? t.Start : null;
    }

    [Fact]
    public void A_parent_link_counts_only_when_the_parent_started_first()
    {
        var t0 = new DateTime(2026, 10, 29, 10, 0, 0, DateTimeKind.Utc);
        var h = new Scripted();
        h.Table[100] = (1, t0);                        // launched
        h.Table[200] = (100, t0.AddSeconds(5));        // its real child
        h.Table[300] = (200, t0.AddSeconds(6));        // grandchild
        h.Table[400] = (500, t0.AddSeconds(1));        // claims parent 500 ...
        h.Table[500] = (100, t0.AddSeconds(9));        // ... which is a reused id that started later
        Assert.True(h.IsDescendantOf(200, [100]));
        Assert.True(h.IsDescendantOf(300, [100]));
        Assert.False(h.IsDescendantOf(400, [100]));
        Assert.False(h.IsDescendantOf(100, [200]));
    }

    [Fact]
    public void Real_processes_on_this_machine()
    {
        if (!OperatingSystem.IsLinux()) return;
        var h = new Rpa.Runner.Core.Ui.SystemProcessHost();
        var me = Environment.ProcessId;
        var parent = h.GetParentPid(me)!.Value;
        Assert.True(h.IsDescendantOf(me, [parent]));
        Assert.False(h.IsDescendantOf(parent, [me]));
    }
}

public class KeyChordTests
{
    [Theory]
    [InlineData("Enter", "Enter")]
    [InlineData("return", "Enter")]
    [InlineData("Tab", "Tab")]
    [InlineData("ctrl+s", "Ctrl+S")]
    [InlineData("Shift+Control+s", "Ctrl+Shift+S")]
    [InlineData("F5", "F5")]
    [InlineData("alt+f4", "Alt+F4")]
    [InlineData("Ctrl + Shift + Esc", "Ctrl+Shift+Escape")]
    [InlineData("Alt", "Alt")]
    [InlineData("shift+ctrl", "Ctrl+Shift")]
    [InlineData("Ctrl+Shift", "Ctrl+Shift")]
    [InlineData("Win+Alt", "Alt+Win")]
    public void Normalises(string input, string expected) => Assert.Equal(expected, KeyChord.Parse(input).ToString());

    [Theory]
    [InlineData("")]
    [InlineData("Ctrl+")]
    [InlineData("Hyper+S")]
    [InlineData("F25")]
    [InlineData("Banana")]
    [InlineData("Alt+Alt")]
    [InlineData("Ctrl+Control+S")]
    [InlineData("Shift+Ctrl+Shift")]
    [InlineData("S+Ctrl")]
    public void Refuses_unknown_chords(string input) =>
        Assert.Equal(RpcErrors.InvalidParams, Assert.Throws<RpcException>(() => KeyChord.Parse(input)).Code);

    [Theory]
    [InlineData("Ctrl+Shift", "Shift+Ctrl")]
    [InlineData("Shift+Control", "ctrl+SHIFT")]
    [InlineData("Alt", "alt")]
    [InlineData("Ctrl+Alt+Delete", "Alt+Control+Del")]
    public void Every_spelling_of_a_chord_is_gated_alike(string gated, string requested)
    {
        var p = RunnerPolicy.Parse($$"""{ "gatedKeys": [{{System.Text.Json.JsonSerializer.Serialize(gated)}}] }""");
        Assert.True(p.IsGatedKey(KeyChord.Parse(requested)));
        Assert.Equal(KeyChord.Parse(gated), KeyChord.Parse(requested));
    }

    [Fact]
    public void A_policy_with_an_unparseable_gated_key_does_not_load() =>
        Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => RunnerPolicy.Parse("""{ "gatedKeys": ["Alt+Alt"] }"""));
}
