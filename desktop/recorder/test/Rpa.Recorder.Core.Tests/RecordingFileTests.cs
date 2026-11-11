using System.Text.Json;
using System.Text.RegularExpressions;
using Rpa.Runner.Core.Policy;
using static Rpa.Recorder.Core.Tests.Fakes;
using RunnerPolicyChange = Rpa.Runner.Core.Policy.PolicyChange;

namespace Rpa.Recorder.Core.Tests;

public class RecordingFileTests
{
    private static readonly ElementFacts Name = El("Edit", "txtName", "Name");
    private static readonly ElementFacts Ok = El("Button", "btnOk", "OK");
    private static readonly string Sha = Convert.ToHexString(new byte[32]).Replace('0', 'a');

    /// <summary>A <c>{{$...}}</c> template as the importer finds it (RESERVED in recording.ts).</summary>
    private static readonly Regex Reserved = new(@"\{\{[\s{]*(\$[^}]*?)\s*\}\}");

    [Fact]
    public void ToFile_output_is_accepted_by_the_engines_fixture_test()
    {
        // The engine imports recording-erp/erp.rpa-recording.json as the 17 steps of the reference flow; the recorder
        // writes exactly that file for the flow's observations.
        var golden = RepoFile("packages", "engine", "test", "fixtures", "import", "recording-erp", "erp.rpa-recording.json");
        var file = Record(ErpDemoObservations.List()).ToFile("ERP Demo line items");
        Assert.Equal(golden.ReplaceLineEndings("\n").TrimEnd(), file.ToJson().ReplaceLineEndings("\n").TrimEnd());
    }

    [Fact]
    public void The_ERP_Demo_file_never_holds_the_password_the_windows_layer_reported()
    {
        var typed = NewSecret();
        var s = Record(ErpDemoObservations.List(typed));
        Assert.False(s.ToFile("ERP Demo line items").ToJson().Contains(typed), "the typed value is in the recording file");
        Assert.False(StringsIn(s).Any(x => x.Contains(typed)), "the typed value is kept in the session");
    }

    [Fact]
    public void A_fill_into_a_Save_dialogs_file_name_types_the_file_into_the_export_folder()
    {
        WindowFacts dialog = new("app.exe", "Save As", "#32770"), main = new("app.exe", "Orders", "AppMain");
        var fileName = El("Edit", "1001", "File name:");
        var s = Record(Click(1, fileName, window: dialog), Typed(2, fileName, dialog), Left(3, fileName, "C:/Users/clerk/report.csv", window: dialog));
        Assert.Equal(("{{$exportDir}}\\report.csv", "report.csv"), (s.Steps[0].Value, s.Steps[0].ExportFile));

        // The same field in another window, or a typed name that is no file name, stays a plain fill.
        s = Record(Typed(1, fileName, main), Left(2, fileName, "report.csv", window: main));
        Assert.Equal(("report.csv", null), (s.Steps[0].Value, s.Steps[0].ExportFile));
        s = Record(Typed(1, fileName, dialog), Left(2, fileName, @"C:\out\", window: dialog));
        Assert.Equal((@"C:\out\", null), (s.Steps[0].Value, s.Steps[0].ExportFile));
    }

    [Fact]
    public void A_recording_file_never_holds_a_template_the_importer_refuses()
    {
        WindowFacts odd = new("app.exe", "{{$exportDir}}", WinFormsClass);
        var button = El("Button", "", "{{ $env.HOME }} now");
        var s = Record(Typed(1, Name, odd), Left(2, Name, "{{$env.HOME}}", window: odd), Click(3, button, window: odd),
            Typed(4, Name, odd), Left(5, Name, "{{var.other}}", window: odd));
        Assert.Equal("{{var.name}}", s.Steps[0].Value);
        Assert.Equal("{{var.name}}", s.Steps[2].Value);
        var json = s.ToFile("Test").ToJson();
        Assert.False(Reserved.IsMatch(json), json);
        Assert.Contains("\"label\": \"{ { $env.HOME }} now\"", json);
    }

    [Fact]
    public void ToFile_refuses_a_name_the_importer_would_refuse_and_an_empty_recording()
    {
        var s = Record(Click(1, Ok));
        foreach (var bad in new[] { "", "two\nlines", new string('x', 201), "{{$exportDir}}" })
            Assert.Throws<ArgumentException>(() => s.ToFile(bad));
        Assert.Equal(new string('x', 200), s.ToFile(new string('x', 200)).Name);
        Assert.Throws<InvalidOperationException>(() => new Session().ToFile("Test"));
    }

    [Fact]
    public void An_app_whose_path_is_not_a_program_is_refused()
    {
        Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\run.bat", [], Window)));
        Assert.Throws<ArgumentException>(() => Record(new AppStarted(At(0), @"C:\Apps\app.exe", ["{{$exportDir}}"], Window)));
    }

    [Fact]
    public void A_check_event_holds_the_state_it_sets()
    {
        var box = El("CheckBox", "1041", "Match case") with { IsChecked = false };
        var json = JsonDocument.Parse(Record(Click(1, box)).ToFile("Test").ToJson()).RootElement;
        var check = json.GetProperty("events")[1];
        Assert.Equal(["at", "kind", "target", "label", "checked"], check.EnumerateObject().Select(p => p.Name));
        Assert.Equal("check", check.GetProperty("kind").GetString());
        Assert.True(check.GetProperty("checked").GetBoolean());
    }

    [Fact]
    public void The_app_comes_from_its_launch_with_its_arguments()
    {
        var s = Record(new AppStarted(At(0), @"C:\Apps\Orders.exe", ["--ui", "v2"], Window), Click(1, Ok));
        var file = s.ToFile("Test");
        Assert.Equal("Orders.exe", file.Exe);
        Assert.Equal(["--ui", "v2"], file.Args);
        var json = JsonDocument.Parse(file.ToJson()).RootElement;
        Assert.Equal("""{"exe":"Orders.exe","args":["--ui","v2"]}""", json.GetProperty("app").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        var launch = json.GetProperty("events")[0];
        Assert.Equal(("launch", "Orders.exe", 2), (launch.GetProperty("kind").GetString(), launch.GetProperty("exe").GetString(), launch.GetProperty("args").GetArrayLength()));
    }

    [Fact]
    public void The_policy_change_allows_the_app_by_path_and_hash_and_declares_no_writes()
    {
        // The policy takes only absolute local paths, so the path is this platform's.
        var path = OperatingSystem.IsWindows() ? @"C:\Program Files\ERP Demo\ErpDemo.exe" : "/opt/ERP Demo/ErpDemo.exe";
        var s = Record(new AppStarted(At(0), path, ["--ui", "v2"], Window), Click(1, Ok));
        var change = s.ToPolicyChange(path, Sha);

        var keys = JsonDocument.Parse(change.ToJson()).RootElement.EnumerateObject().Select(p => p.Name);
        Assert.Equal(["allowedApps"], keys);
        var policy = RunnerPolicy.Parse(RunnerPolicyChange.Apply("", change.ToJson()).Json);
        var app = Assert.Single(policy.AllowedApps);
        Assert.Equal(("ErpDemo.exe", path, Sha.ToUpperInvariant()), (app.Exe, app.Path, app.Sha256));
        Assert.Equal(["--ui", "v2"], Assert.Single(app.AllowedArgs));
        Assert.Empty(policy.WriteControls);
        Assert.Empty(policy.GatedKeys);

        // Without arguments there is no allowedArgs; a hash that is not SHA-256, or another program, is refused.
        var plain = Record(new AppStarted(At(0), path, [], Window)).ToPolicyChange(path, Sha);
        Assert.DoesNotContain("allowedArgs", plain.ToJson());
        Assert.Throws<ArgumentException>(() => s.ToPolicyChange(path, "abc"));
        Assert.Throws<ArgumentException>(() => s.ToPolicyChange(path.Replace("ErpDemo", "Other"), Sha));
    }
}
