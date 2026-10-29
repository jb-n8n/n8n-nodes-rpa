using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Tests;

public class PolicyTests
{
    private const string Example = """
        { "allowedApps": [{ "exe": "ErpDemo.exe" }], "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }],
          "gatedKeys": ["Ctrl+S", "F11"], "maxFileBytes": 20971520 }
        """;

    [Fact]
    public void Parses_the_contract_example()
    {
        var p = RunnerPolicy.Parse(Example);
        Assert.True(p.IsAllowedExe("erpdemo.EXE"));
        Assert.False(p.IsAllowedExe("notepad.exe"));
        Assert.True(p.IsWriteControl("ERPDEMO.exe", "btnPost"));
        Assert.False(p.IsWriteControl("ErpDemo.exe", "BTNPOST"));
        Assert.False(p.IsWriteControl("Other.exe", "btnPost"));
        Assert.True(p.IsGatedKey(KeyChord.Parse("ctrl+s")));
        Assert.True(p.IsGatedKey(KeyChord.Parse("f11")));
        Assert.False(p.IsGatedKey(KeyChord.Parse("Ctrl+Shift+S")));
        Assert.Equal(20971520, p.MaxFileBytes);
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
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "signer": "x" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "C:\\apps\\ErpDemo.exe" }] }""")]
    [InlineData("""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": "relative\\ErpDemo.exe" }] }""")]
    [InlineData("""{ "writeControls": [{ "exe": "ErpDemo.exe" }] }""")]
    [InlineData("""{ "gatedKeys": ["Ctrl+Banana"] }""")]
    [InlineData("""{ "maxFileBytes": 0 }""")]
    [InlineData("""not json""")]
    public void Refuses_invalid_policies(string json)
    {
        Assert.Throws<RunnerPolicy.InvalidPolicyException>(() => RunnerPolicy.Parse(json));
    }

    [Fact]
    public void Launch_refuses_apps_not_in_the_list()
    {
        var p = RunnerPolicy.Parse(Example);
        var e = Assert.Throws<RpcException>(() => p.ResolveLaunch("/opt/apps/notepad.exe"));
        Assert.Equal(RpcErrors.PolicyRefusedCode, e.Code);
        Assert.Contains("notepad.exe", e.Message);
    }

    [Fact]
    public void Launch_without_a_pinned_path_needs_an_absolute_path()
    {
        var p = RunnerPolicy.Parse(Example);
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch("ErpDemo.exe")).Code);
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch("apps/ErpDemo.exe")).Code);
        var abs = Path.Combine(Path.GetTempPath(), "ErpDemo.exe");
        Assert.Equal(abs, p.ResolveLaunch(abs));
    }

    [Fact]
    public void Several_pinned_paths_for_one_exe()
    {
        var v1 = Path.Combine(Path.GetTempPath(), "v1", "ErpDemo.exe");
        var v2 = Path.Combine(Path.GetTempPath(), "v2", "ErpDemo.exe");
        var p = RunnerPolicy.Parse($$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{System.Text.Json.JsonSerializer.Serialize(v1)}} }, { "exe": "ErpDemo.exe", "path": {{System.Text.Json.JsonSerializer.Serialize(v2)}} }] }""");
        Assert.Equal(v1, p.ResolveLaunch("ErpDemo.exe"));
        Assert.Equal(v2, p.ResolveLaunch(v2));
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch(Path.Combine(Path.GetTempPath(), "v3", "ErpDemo.exe"))).Code);
    }

    [Fact]
    public void Launch_with_a_pinned_path_starts_only_that_file()
    {
        var pinned = Path.Combine(Path.GetTempPath(), "erp", "ErpDemo.exe");
        var p = RunnerPolicy.Parse($$"""{ "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{System.Text.Json.JsonSerializer.Serialize(pinned)}} }] }""");
        Assert.Equal(pinned, p.ResolveLaunch("ErpDemo.exe"));
        Assert.Equal(pinned, p.ResolveLaunch(pinned));
        var elsewhere = Path.Combine(Path.GetTempPath(), "evil", "ErpDemo.exe");
        Assert.Equal(RpcErrors.PolicyRefusedCode, Assert.Throws<RpcException>(() => p.ResolveLaunch(elsewhere)).Code);
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
    public void Normalises(string input, string expected) => Assert.Equal(expected, KeyChord.Parse(input).ToString());

    [Theory]
    [InlineData("")]
    [InlineData("Ctrl+")]
    [InlineData("Hyper+S")]
    [InlineData("F25")]
    [InlineData("Banana")]
    public void Refuses_unknown_chords(string input) =>
        Assert.Equal(RpcErrors.InvalidParams, Assert.Throws<RpcException>(() => KeyChord.Parse(input)).Code);
}
