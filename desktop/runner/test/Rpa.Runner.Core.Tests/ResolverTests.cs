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
        Assert.Contains("found 2 list items", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void Several_visible_matches_are_not_unique_with_the_count()
    {
        var e = _h.Err("resolve", Resolve(Harness.T(new { controlType = "Button" })), RpcErrors.NotUniqueCode);
        Assert.Contains("found 3 buttons", e["message"]!.GetValue<string>());
        Assert.Equal("not_unique", e["data"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void The_failure_texts_name_what_the_targets_last_condition_found()
    {
        var copy = new Target(null, [new Cond("Button", null, "Copy", null, null)], []);
        var buttons = new Target(new WindowSel("erpdemo.exe", "ERP Demo - Line items", null, null, null), [new Cond("Button", null, null, null, null)], []);
        var boxes = new Target(null, [new Cond("Pane", "grpFilter", null, null, null), new Cond("Edit", "txtFrom", null, null, null)], []);
        var checks = new Target(null, [new Cond("CheckBox", null, null, null, null)], []);
        const string add = "Add what tells them apart to the step's target: the window, a parent with an automationId, or a condition such as";
        const string hint = "If a person can click it, target an enabled element inside it, or use key steps (Tab, Space).";
        Assert.Equal($"not_unique: found 2 buttons named \"Copy\". {add} automationId or className. Target: {{controlType=\"Button\", name=\"Copy\"}}",
            RpcErrors.NotUnique(2, copy).Message);
        Assert.Equal($"not_unique: found 7 buttons. {add} name, automationId or className. " +
            "Target: {exe=\"erpdemo.exe\", title=\"ERP Demo - Line items\"} :: {controlType=\"Button\"}", RpcErrors.NotUnique(7, buttons).Message);
        Assert.Equal($"not_unique: found 2 text boxes with the id \"txtFrom\". {add} name or className. " +
            "Target: {controlType=\"Pane\", automationId=\"grpFilter\"} > {controlType=\"Edit\", automationId=\"txtFrom\"}", RpcErrors.NotUnique(2, boxes).Message);
        Assert.StartsWith("not_unique: found 2 check boxes. ", RpcErrors.NotUnique(2, checks).Message);
        Assert.Equal($"timeout: found the button named \"Copy\" disabled. {hint} Target: {{controlType=\"Button\", name=\"Copy\"}}", RpcErrors.Disabled(copy).Message);
        Assert.Equal($"timeout: found the focused element disabled. {hint}", RpcErrors.Disabled(null).Message);
    }

    /// <summary>Puts the harness's desktop on its fake clock, moved one second at every look at the windows, so each
    /// attempt of the resolver is a second after the one before. <paramref name="onLook"/> runs at each look (1-based).
    /// Returns the clock's time at each look.</summary>
    private static List<DateTimeOffset> OneSecondPerLook(Harness h, Action<int>? onLook = null)
    {
        var time = h.Time!;
        var looks = new List<DateTimeOffset>();
        h.Desktop.OnLook = () =>
        {
            looks.Add(time.GetUtcNow());
            onLook?.Invoke(looks.Count);
            time.Advance(TimeSpan.FromSeconds(1));
        };
        return looks;
    }

    [Fact]
    public void A_locator_that_matches_several_elements_for_3_s_is_not_unique_after_3_s_not_after_the_timeout()
    {
        using var h = new Harness(realTime: false);
        h.BeginWithApp();
        var looks = OneSecondPerLook(h);
        var t0 = h.Time!.GetUtcNow();
        var e = h.Err("resolve", Resolve(Harness.T(new { controlType = "Button" }), 20000), RpcErrors.NotUniqueCode);
        Assert.Equal(
            "not_unique: found 3 buttons. Add what tells them apart to the step's target: the window, a parent with an automationId, " +
            "or a condition such as name, automationId or className. Target: {controlType=\"Button\"}",
            e["message"]!.GetValue<string>());
        // Three on every look from the first to the one 3 s later, and no wait for the rest of the 20 s.
        Assert.Equal(TimeSpan.FromSeconds(3), looks[^1] - looks[0]);
        Assert.True(h.Time.GetUtcNow() - t0 < TimeSpan.FromSeconds(5), $"waited {h.Time.GetUtcNow() - t0}");
    }

    [Fact]
    public void A_step_timeout_under_3_s_keeps_its_own_timeout_for_several_matches()
    {
        using var h = new Harness(realTime: false);
        h.BeginWithApp();
        OneSecondPerLook(h);
        var t0 = h.Time!.GetUtcNow();
        h.Err("resolve", Resolve(Harness.T(new { controlType = "Button" }), 1000), RpcErrors.NotUniqueCode);
        Assert.Equal(TimeSpan.FromSeconds(1), h.Time.GetUtcNow() - t0);
    }

    [Fact]
    public void Two_matches_that_become_one_within_3_s_resolve()
    {
        using var h = new Harness(realTime: false);
        var w = h.BeginWithApp();
        w.Child("Button", "Copy", "btnCopyA").Child("Button", "Copy", "btnCopyB");
        var second = w.Find("btnCopyB");
        // A window still drawing: two Copy buttons at first, the second gone from the third look (2 s in).
        OneSecondPerLook(h, look => { if (look == 3) second.IsOffscreen = true; });
        var r = h.Ok("resolve", Resolve(Harness.T(new { controlType = "Button", name = "Copy" }), 20000));
        Assert.Equal(0, r["candidate"]!.GetValue<int>());
    }

    [Fact]
    public void The_3_s_count_again_from_the_first_look_with_several_matches_after_one_without()
    {
        using var h = new Harness(realTime: false);
        var w = h.BeginWithApp();
        w.Child("Button", "Copy", "btnCopyA").Child("Button", "Copy", "btnCopyB");
        var first = w.Find("btnCopyA");
        var second = w.Find("btnCopyB");
        // Two at looks 1 and 2, none at look 3 (both offscreen), two again from look 4.
        var looks = OneSecondPerLook(h, look => first.IsOffscreen = second.IsOffscreen = look == 3);
        h.Err("resolve", Resolve(Harness.T(new { controlType = "Button", name = "Copy" }), 20000), RpcErrors.NotUniqueCode);
        // Looks 4 to 7 are 3 s of two matches.
        Assert.Equal(7, looks.Count);
    }

    [Fact]
    public void No_match_keeps_waiting_for_the_whole_timeout()
    {
        using var h = new Harness(realTime: false);
        h.BeginWithApp();
        OneSecondPerLook(h);
        var t0 = h.Time!.GetUtcNow();
        h.Err("resolve", Resolve(Harness.T(new { automationId = "btnNotThereYet" }), 10000), RpcErrors.NotFoundCode);
        Assert.Equal(TimeSpan.FromSeconds(10), h.Time.GetUtcNow() - t0);
    }

    [Fact]
    public void A_disabled_element_keeps_waiting_for_the_whole_timeout_and_says_what_to_do()
    {
        using var h = new Harness(realTime: false);
        var w = h.BeginWithApp();
        w.Find("btnSignIn").IsEnabled = false;
        var time = h.Time!;
        var tries = 0;
        h.Desktop.BeforeInput = _ =>
        {
            tries++;
            time.Advance(TimeSpan.FromSeconds(1));
        };
        var t0 = time.GetUtcNow();
        var e = h.Err("act", new { runId = Harness.RunId, target = Harness.T(new { automationId = "btnSignIn" }), action = "click", timeoutMs = 10000 },
            RpcErrors.TimeoutCode);
        Assert.Equal(
            "timeout: found the element with the id \"btnSignIn\" disabled. " +
            "If a person can click it, target an enabled element inside it, or use key steps (Tab, Space). Target: {automationId=\"btnSignIn\"}",
            e["message"]!.GetValue<string>());
        Assert.True(time.GetUtcNow() - t0 >= TimeSpan.FromSeconds(10), $"waited {time.GetUtcNow() - t0}");
        Assert.Equal(10, tries);
        Assert.Empty(h.Desktop.Performed);
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
        Assert.Equal(
            "policy_refused: the window {exe=\"notepad.exe\"} belongs to \"notepad.exe\", which is not an application this run launched from the allowed list",
            e["message"]!.GetValue<string>());
    }

    [Fact]
    public void An_allowed_exe_that_this_run_did_not_launch_is_not_the_runs()
    {
        var foreign = Harness.MainWindow(5555);
        _h.Processes.Names[5555] = "ErpDemo.exe";
        _h.Desktop.Windows.Clear();
        _h.Desktop.Windows.Add(foreign);
        var e = _h.Err("resolve", Resolve(new { window = new { exe = "ErpDemo.exe" }, path = new object[] { new { automationId = "btnSignIn" } } }),
            RpcErrors.PolicyRefusedCode);
        // Its path is unknown, so it is not known to be a copy of the allowed app: the general text.
        Assert.Equal(
            "policy_refused: the window {exe=\"ErpDemo.exe\"} belongs to \"ErpDemo.exe\", which is not an application this run launched from the allowed list",
            e["message"]!.GetValue<string>());
    }

    [Fact]
    public void A_copy_of_the_allowed_app_that_this_run_did_not_start_is_refused_with_what_to_do()
    {
        // An app that keeps one window: the copy a person left open holds the window, and the run's own copy is gone.
        var foreign = Harness.MainWindow(5555);
        _h.Processes.Names[5555] = "ErpDemo.exe";
        _h.Processes.Paths[5555] = _h.AppPath;
        _h.Desktop.Windows.Clear();
        _h.Desktop.Windows.Add(foreign);
        var e = _h.Err("resolve", Resolve(new { window = new { title = "ERP Demo - Line items" }, path = new object[] { new { automationId = "btnSignIn" } } }),
            RpcErrors.PolicyRefusedCode);
        Assert.Equal(
            "policy_refused: found its window in a copy of ErpDemo.exe that this run did not start (most often one left open before the run). " +
            "Close that copy on the runner machine (or end its process), then run again. Window: {title=\"ERP Demo - Line items\"}",
            e["message"]!.GetValue<string>());
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
