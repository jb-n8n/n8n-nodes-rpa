using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core.Tests;

public sealed class ResolverTests : IDisposable
{
    private readonly Harness _h = new();
    private readonly FakeNode _w;

    public ResolverTests() => _w = _h.BeginWithApp();

    public void Dispose() => _h.Dispose();

    private object Resolve(object target, int timeoutMs = 0) => new { runId = Harness.RunId, target, timeoutMs };

    [Fact]
    public void Path_conditions_are_matched_as_descendants_in_order()
    {
        Assert.Equal(0, _h.Ok("resolve", Resolve(Harness.T(new { automationId = "btnInner" })))["candidate"]!.GetValue<int>());
        Assert.Equal(0, _h.Ok("resolve", Resolve(Harness.T(new { controlType = "List" }, new { name = "Row B" })))["candidate"]!.GetValue<int>());
        // Row B is not a descendant of the Pane.
        var e = _h.Err("resolve", Resolve(Harness.T(new { controlType = "pane" }, new { name = "Row B" })), RpcErrors.NotFoundCode);
        Assert.Contains("name=\"Row B\"", e["message"]!.GetValue<string>());
        Assert.Contains("ERP Demo - Line items", e["message"]!.GetValue<string>());
        Assert.Equal("not_found", e["data"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void Control_type_matches_case_insensitively_and_other_properties_exactly()
    {
        _h.Ok("resolve", Resolve(Harness.T(new { controlType = "button", name = "Sign in" })));
        _h.Err("resolve", Resolve(Harness.T(new { controlType = "Button", name = "sign in" })), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void Index_picks_among_siblings_that_match_the_rest()
    {
        var r = _h.Ok("act", new { runId = Harness.RunId, target = Harness.T(new { controlType = "ListItem", index = 1 }), action = "read" });
        Assert.Equal("Row B", r["text"]!.GetValue<string>());
        _h.Err("resolve", Resolve(Harness.T(new { controlType = "ListItem", index = 2 })), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void Index_applies_per_parent()
    {
        var second = new FakeNode("List", "Second", "lstSecond", _w.ProcessId);
        second.Child("ListItem", "Row C").Child("ListItem", "Row D");
        _w.Add(second);
        // index 0 within each list: two matches.
        var e = _h.Err("resolve", Resolve(Harness.T(new { controlType = "ListItem", index = 0 })), RpcErrors.NotUniqueCode);
        Assert.Contains("matched 2", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void Several_visible_matches_are_not_unique_with_the_count()
    {
        var e = _h.Err("resolve", Resolve(Harness.T(new { controlType = "Button" })), RpcErrors.NotUniqueCode);
        Assert.Contains("matched 3", e["message"]!.GetValue<string>());
        Assert.Equal("not_unique", e["data"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void Offscreen_elements_do_not_count()
    {
        _w.Find("btnPost").IsOffscreen = true;
        _w.Find("btnInner").IsOffscreen = true;
        Assert.Equal(0, _h.Ok("resolve", Resolve(Harness.T(new { controlType = "Button" })))["candidate"]!.GetValue<int>());
    }

    [Fact]
    public void The_first_fallback_that_matches_exactly_one_wins()
    {
        var target = new
        {
            path = new object[] { new { automationId = "btnSearch" } },
            fallbacks = new object[]
            {
                new { path = new object[] { new { controlType = "Button" } } },          // 3 matches
                new { path = new object[] { new { name = "Sign in" } } },                // exactly one
                new { path = new object[] { new { automationId = "btnInner" } } },
            },
        };
        Assert.Equal(2, _h.Ok("resolve", Resolve(target))["candidate"]!.GetValue<int>());
    }

    [Fact]
    public void A_fallback_wins_over_an_ambiguous_primary()
    {
        var target = new
        {
            path = new object[] { new { controlType = "Button" } },
            fallbacks = new object[] { new { path = new object[] { new { automationId = "btnSignIn" } } } },
        };
        Assert.Equal(1, _h.Ok("resolve", Resolve(target))["candidate"]!.GetValue<int>());
    }

    [Fact]
    public void Resolve_waits_for_the_element_until_the_timeout()
    {
        var late = new Thread(() =>
        {
            Thread.Sleep(300);
            _w.Child("Button", "Late", "btnLate");
        });
        late.Start();
        Assert.Equal(0, _h.Ok("resolve", Resolve(Harness.T(new { automationId = "btnLate" }), 3000))["candidate"]!.GetValue<int>());
        late.Join();
    }

    [Fact]
    public void Windows_of_other_processes_are_not_searched()
    {
        var other = new FakeNode("Window", "Notepad", "", 9999);
        other.Child("Button", "Elsewhere", "btnElsewhere");
        _h.Processes.Names[9999] = "notepad.exe";
        _h.Desktop.Windows.Insert(0, other);
        _h.Err("resolve", Resolve(Harness.T(new { automationId = "btnElsewhere" })), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void A_window_selector_that_only_matches_another_app_is_refused()
    {
        var other = new FakeNode("Window", "Notepad", "", 9999);
        other.Child("Button", "Elsewhere", "btnElsewhere");
        _h.Processes.Names[9999] = "notepad.exe";
        _h.Desktop.Windows.Insert(0, other);
        var target = new { window = new { exe = "notepad.exe" }, path = new object[] { new { automationId = "btnElsewhere" } } };
        var e = _h.Err("resolve", Resolve(target), RpcErrors.PolicyRefusedCode);
        Assert.Contains("notepad.exe", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void An_allowed_exe_that_this_run_did_not_launch_is_not_the_runs()
    {
        var foreign = Harness.MainWindow(5555);
        _h.Processes.Names[5555] = "ErpDemo.exe";
        _h.Desktop.Windows.Clear();
        _h.Desktop.Windows.Add(foreign);
        _h.Err("resolve", Resolve(new { window = new { exe = "ErpDemo.exe" }, path = new object[] { new { automationId = "btnSignIn" } } }),
            RpcErrors.PolicyRefusedCode);
    }

    [Fact]
    public void Child_processes_of_a_launched_app_count_when_their_exe_is_allowed()
    {
        var launched = _h.Processes.Names.Keys.Single();
        var dialog = new FakeNode("Window", "Export", "", 6000);
        dialog.Child("Button", "Save", "btnChildSave");
        _h.Processes.Names[6000] = "ErpDemo.exe";
        _h.Processes.Paths[6000] = _h.AppPath;
        _h.Processes.Parents[6000] = launched;
        _h.Desktop.Windows.Add(dialog);
        _h.Ok("resolve", Resolve(Harness.T(new { automationId = "btnChildSave" })));
    }

    [Fact]
    public void A_descendant_with_the_allowed_file_name_but_another_path_is_not_the_runs()
    {
        var launched = _h.Processes.Names.Keys.Single();
        var planted = new FakeNode("Window", "Planted", "", 6100);
        planted.Child("Button", "Run", "btnPlanted");
        _h.Processes.Names[6100] = "ErpDemo.exe";
        _h.Processes.Paths[6100] = Path.Combine(_h.Root, "exports", "ErpDemo.exe");
        _h.Processes.Parents[6100] = launched;
        _h.Desktop.Windows.Insert(0, planted);
        _h.Err("resolve", Resolve(Harness.T(new { automationId = "btnPlanted" })), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void Elements_another_process_hosts_inside_a_run_window_do_not_count()
    {
        _h.Processes.Names[7100] = "msedgewebview2.exe";
        _h.Processes.Paths[7100] = "/opt/edge/msedgewebview2.exe";
        _w.Add(new FakeNode("Button", "Hosted", "btnHosted", 7100));
        _h.Err("resolve", Resolve(Harness.T(new { automationId = "btnHosted" })), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void Window_selectors_match_title_pattern_class_and_exe()
    {
        var dialog = new FakeNode("Window", "Export line items", "dlgExport", _w.ProcessId) { ClassName = "#32770" };
        dialog.Child("Button", "Save", "1");
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Ok("resolve", Resolve(new { window = new { titlePattern = "^Export", className = "#32770", exe = "erpdemo.exe" }, path = new object[] { new { automationId = "1" } } }));
        _h.Err("resolve", Resolve(new { window = new { title = "Export" }, path = new object[] { new { automationId = "1" } } }), RpcErrors.NotFoundCode);
    }

    [Fact]
    public void IsVisible_is_true_when_any_candidate_has_a_visible_match()
    {
        Assert.True(_h.Ok("isVisible", new { runId = Harness.RunId, target = Harness.T(new { controlType = "Button" }) })["visible"]!.GetValue<bool>());
        Assert.False(_h.Ok("isVisible", new { runId = Harness.RunId, target = Harness.T(new { automationId = "nope" }) })["visible"]!.GetValue<bool>());
        _w.Find("btnInner").IsOffscreen = true;
        Assert.False(_h.Ok("isVisible", new { runId = Harness.RunId, target = Harness.T(new { automationId = "btnInner" }) })["visible"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("""{ "path": [] }""")]
    [InlineData("""{ "path": [{ "index": 0 }] }""")]
    [InlineData("""{ "path": [{ "name": "x", "index": -1 }] }""")]
    [InlineData("""{ "path": [{ "name": 3 }] }""")]
    [InlineData("""{ "path": [{ "name": "x" }], "fallbacks": [{ "path": [{ "name": "y" }], "fallbacks": [] }] }""")]
    [InlineData("""{ "window": { "titlePattern": "(" }, "path": [{ "name": "x" }] }""")]
    public void Invalid_targets_are_invalid_params(string target)
    {
        _h.Err("resolve", new { runId = Harness.RunId, target = System.Text.Json.JsonDocument.Parse(target).RootElement, timeoutMs = 0 }, RpcErrors.InvalidParams);
    }
}
