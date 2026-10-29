using System.Text.Json.Nodes;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core.Tests;

public sealed class ServiceTests : IDisposable
{
    private readonly Harness _h = new();

    public void Dispose() => _h.Dispose();

    private static object Act(object target, string action, object? extra = null)
    {
        var o = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(new { runId = Harness.RunId, target, action, timeoutMs = 0 }))!.AsObject();
        if (extra is not null)
            foreach (var kv in JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(extra))!.AsObject().ToList())
                o[kv.Key] = kv.Value?.DeepClone();
        return o;
    }

    private static object Id(string automationId) => Harness.T(new { automationId });

    [Fact]
    public void Hello_reports_protocol_version_os_and_session()
    {
        _h.Desktop.Session = new SessionState(true, true, false);
        var r = _h.Ok("hello", new { });
        Assert.Equal(1, r["protocol"]!.GetValue<int>());
        Assert.Equal("0.1.0-test", r["runner"]!["version"]!.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(r["runner"]!["os"]!.GetValue<string>()));
        Assert.True(r["runner"]!["session"]!["interactive"]!.GetValue<bool>());
        Assert.True(r["runner"]!["session"]!["locked"]!.GetValue<bool>());
    }

    [Fact]
    public void Methods_other_than_hello_and_run_begin_need_the_active_run_id()
    {
        foreach (var m in new[] { "run.heartbeat", "run.end", "app.launch", "snapshot", "isVisible", "resolve", "act", "file.retrieve", "screenshot" })
            _h.Err(m, new { runId = "nope" }, RpcErrors.NoRunCode);
        _h.Begin();
        _h.Err("snapshot", new { runId = "other" }, RpcErrors.NoRunCode);
        _h.Err("snapshot", new { }, RpcErrors.NoRunCode);
    }

    [Fact]
    public void Run_begin_twice_is_busy_and_run_end_releases()
    {
        _h.Begin();
        var e = _h.Err("run.begin", new { runId = "run-2", leaseMs = 30000 }, RpcErrors.RunnerBusyCode);
        Assert.Equal("runner_busy", e["data"]!["name"]!.GetValue<string>());
        _h.Ok("run.heartbeat", new { runId = Harness.RunId });
        _h.Ok("run.end", new { runId = Harness.RunId });
        Assert.False(Directory.Exists(_h.ExportDir));
        _h.Ok("run.begin", new { runId = "run-2", leaseMs = 30000 });
    }

    [Fact]
    public void Run_end_closes_the_processes_the_run_launched()
    {
        _h.BeginWithApp();
        var pid = _h.Processes.Names.Keys.Single();
        _h.Ok("run.end", new { runId = Harness.RunId });
        Assert.Equal([pid], _h.Processes.Killed);
    }

    [Fact]
    public void A_locked_or_unreachable_desktop_is_desktop_unavailable()
    {
        _h.Desktop.Session = new SessionState(true, true, true);
        _h.Err("run.begin", new { runId = Harness.RunId, leaseMs = 30000 }, RpcErrors.DesktopUnavailableCode);
        _h.Desktop.Session = new SessionState(true, false, true);
        _h.Begin();
        _h.Desktop.Session = new SessionState(true, false, false);
        var e = _h.Err("act", Act(Id("btnSignIn"), "click"), RpcErrors.DesktopUnavailableCode);
        Assert.Contains("input desktop", e["message"]!.GetValue<string>());
        _h.Desktop.Session = new SessionState(false, false, true);
        _h.Err("snapshot", new { runId = Harness.RunId }, RpcErrors.DesktopUnavailableCode);
        _h.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe" } }, RpcErrors.DesktopUnavailableCode);
        // Heartbeat and end still work, so the run can be closed cleanly.
        _h.Ok("run.heartbeat", new { runId = Harness.RunId });
        _h.Ok("run.end", new { runId = Harness.RunId });
    }

    [Fact]
    public void App_launch_refuses_apps_not_in_the_policy()
    {
        _h.Begin();
        var e = _h.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "C:\\Windows\\notepad.exe" } }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("notepad.exe", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Processes.Started);
    }

    [Fact]
    public void App_launch_starts_the_pinned_path_with_args_and_returns_the_pid()
    {
        _h.Begin();
        var r = _h.Ok("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe", args = new[] { "--ui", "v2" } } });
        Assert.True(r["pid"]!.GetValue<int>() > 0);
        var (path, args) = Assert.Single(_h.Processes.Started);
        Assert.Equal(_h.AppPath, path);
        Assert.Equal(["--ui", "v2"], args);
    }

    [Fact]
    public void App_launch_refuses_unlisted_arguments_a_user_writable_path_and_a_wrong_hash()
    {
        _h.Begin();
        _h.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe", args = new[] { "--evil" } } }, RpcErrors.PolicyRefusedCode);
        _h.Paths.Writable = true;
        var e = _h.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe" } }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("replace", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Processes.Started);
    }

    [Fact]
    public void App_launch_checks_the_pinned_hash_and_allows_user_writable_paths_only_when_the_policy_says_so()
    {
        using var probe = new Harness();
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(probe.AppPath)));
        string Policy(string sha) => $$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{System.Text.Json.JsonSerializer.Serialize(probe.AppPath)}}, "sha256": "{{sha}}", "allowUserWritable": true }] }
            """;
        using (var good = new Harness(Policy(hash.ToLowerInvariant())))
        {
            File.WriteAllText(good.AppPath, "fake"); // same content as the probe's file
            good.Paths.Writable = true;
            good.Begin();
            good.Ok("app.launch", new { runId = Harness.RunId, app = new { exe = probe.AppPath } });
        }
        using var bad = new Harness(Policy(new string('0', 64)));
        bad.Begin();
        bad.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe" } }, RpcErrors.PolicyRefusedCode);
    }

    [Fact]
    public void Export_dirs_are_created_private()
    {
        _h.Begin();
        Assert.Contains(Path.GetFullPath(_h.ExportDir!), _h.Paths.Private);
        Assert.Contains(Path.GetFullPath(Path.Combine(_h.Root, "exports")), _h.Paths.Private);
    }

    [Theory]
    [InlineData("Win")]
    [InlineData("Win+R")]
    [InlineData("Win+2")]
    [InlineData("Ctrl+Escape")]
    [InlineData("Ctrl+Shift+Esc")]
    [InlineData("Alt+Tab")]
    [InlineData("Alt+Shift+Tab")]
    [InlineData("Alt+Esc")]
    public void Shell_chords_are_never_sent_even_with_write_true(string key)
    {
        _h.BeginWithApp();
        var e = _h.Err("act", Act(Id("txtUser"), "key", new { value = key, write = true }), RpcErrors.PolicyRefusedCode);
        Assert.Contains("shell", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Theory]
    [InlineData("Ctrl+Shift+S")]
    [InlineData("Ctrl+Alt+S")]
    [InlineData("Shift+F11")]
    public void Gated_keys_also_gate_extra_modifiers(string key)
    {
        _h.BeginWithApp();
        var e = _h.Err("act", Act(Id("txtUser"), "key", new { value = key }), RpcErrors.PolicyRefusedCode);
        Assert.Contains("gated", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void A_run_end_while_the_app_starts_stops_the_app()
    {
        _h.Begin();
        _h.Processes.OnStart = _ => _h.Runs.End(Harness.RunId);
        _h.Err("app.launch", new { runId = Harness.RunId, app = new { exe = "ErpDemo.exe" } }, RpcErrors.NoRunCode);
        Assert.Equal(_h.Processes.Paths.Keys, _h.Processes.Killed);
    }

    [Fact]
    public void Repair_mode_clicks_must_land_on_the_target_or_an_inert_part_of_it()
    {
        var w = _h.BeginWithApp();
        var row = w.Find("Row A");
        var inner = new FakeNode("Button", "Delete row", "btnRowDelete");
        row.Add(inner);
        var caption = new FakeNode("Text", "Row A text", "");
        row.Add(caption);
        _h.Desktop.InputReceiver = inner;
        _h.Err("act", Act(Harness.T(new { name = "Row A" }), "click", new { mode = "repair" }), RpcErrors.PolicyRefusedCode);
        _h.Desktop.InputReceiver = caption;
        _h.Ok("act", Act(Harness.T(new { name = "Row A" }), "click", new { mode = "repair" }));
    }

    [Fact]
    public void Keyboard_input_with_an_unknown_focus_is_never_sent()
    {
        _h.BeginWithApp();
        _h.Desktop.FocusUnknown = true;
        var e = _h.Err("act", Act(Id("txtUser"), "type", new { value = "typed-x", timeoutMs = 600 }), RpcErrors.TimeoutCode);
        Assert.Contains("keyboard focus", e["message"]!.GetValue<string>());
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "Tab", timeoutMs = 600 }), RpcErrors.TimeoutCode);
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void A_key_without_a_target_and_an_unknown_focus_is_refused()
    {
        _h.BeginWithApp();
        _h.Desktop.Focused = null;
        var e = _h.Err("act", new { runId = Harness.RunId, action = "key", value = "Tab", timeoutMs = 500 }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("keyboard focus", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Theory]
    [InlineData(false, true, 1)]
    [InlineData(true, false, 1)]
    [InlineData(true, true, 2)]
    public void The_keyboard_receiver_check_fails_closed(bool foregroundKnown, bool expected, int focusPid)
    {
        var focused = new FakeNode("Edit", "x", "x", pid: 1);
        Assert.Throws<RetryableActionException>(() => KeyboardFocusCheck.Receiver(foregroundKnown, expected, focusPid, focused));
        Assert.Throws<RetryableActionException>(() => KeyboardFocusCheck.Receiver(true, true, 1, null));
        Assert.Same(focused, KeyboardFocusCheck.Receiver(true, true, 1, focused));
    }

    [Fact]
    public void Write_controls_need_write_true()
    {
        _h.BeginWithApp();
        var e = _h.Err("act", Act(Id("btnPost"), "click"), RpcErrors.PolicyRefusedCode);
        Assert.Contains("write: true", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
        _h.Ok("act", Act(Id("btnPost"), "click", new { write = true }));
        Assert.Single(_h.Desktop.Performed);
    }

    [Fact]
    public void A_child_of_a_write_control_counts_as_the_write_control()
    {
        _h.BeginWithApp();
        _h.Err("act", Act(Id("lblPostCaption"), "click"), RpcErrors.PolicyRefusedCode);
    }

    [Fact]
    public void Input_that_would_land_on_a_write_control_is_refused()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.InputReceiver = w.Find("btnPost");
        _h.Err("act", Act(Id("btnSignIn"), "click"), RpcErrors.PolicyRefusedCode);
        _h.Ok("act", Act(Id("btnSignIn"), "click", new { write = true }));
    }

    [Fact]
    public void Input_that_would_land_in_another_application_is_refused()
    {
        _h.BeginWithApp();
        _h.Processes.Names[777] = "notepad.exe";
        _h.Desktop.InputReceiver = new FakeNode("Edit", "Text editor", "", 777);
        var e = _h.Err("act", Act(Id("btnSignIn"), "click", new { write = true }), RpcErrors.PolicyRefusedCode);
        Assert.Contains("another application", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void Gated_keys_need_write_true_in_any_spelling()
    {
        _h.BeginWithApp();
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "ctrl+s" }), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "F11" }), RpcErrors.PolicyRefusedCode);
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = "Control+S", write = true }));
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = "Tab" }));
        Assert.Equal("Tab", _h.Desktop.Performed[^1].Key!.ToString());
    }

    [Fact]
    public void Key_without_a_target_goes_to_the_focused_element_under_the_same_floor()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        _h.Ok("act", new { runId = Harness.RunId, action = "key", value = "Tab", timeoutMs = 0 });
        Assert.Equal("txtUser", _h.Desktop.Performed[^1].Element.AutomationId);
        _h.Err("act", new { runId = Harness.RunId, action = "key", value = "Enter", timeoutMs = 0 }, RpcErrors.PolicyRefusedCode);
        // The focus on a write control: even navigation needs write: true.
        _h.Desktop.Focused = w.Find("btnPost");
        _h.Err("act", new { runId = Harness.RunId, action = "key", value = "Tab", timeoutMs = 0 }, RpcErrors.PolicyRefusedCode);
        _h.Ok("act", new { runId = Harness.RunId, action = "key", value = "Enter", write = true, timeoutMs = 0 });
        _h.Err("act", new { runId = Harness.RunId, action = "click", timeoutMs = 0 }, RpcErrors.InvalidParams);
    }

    [Theory]
    [InlineData("Enter")]
    [InlineData("ctrl+enter")]
    [InlineData("Space")]
    [InlineData("Alt+P")]
    [InlineData("alt+1")]
    [InlineData("F10")]
    [InlineData("Alt")]
    [InlineData("Shift+F10")]
    [InlineData("Apps")]
    [InlineData("Ctrl+P")]
    [InlineData("Shift+Down")]
    public void Keys_other_than_navigation_need_write_true_while_the_run_has_a_write_control(string key)
    {
        var w = _h.BeginWithApp();
        var e = _h.Err("act", Act(Id("txtUser"), "key", new { value = key }), RpcErrors.PolicyRefusedCode);
        Assert.Contains("write control", e["message"]!.GetValue<string>());
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = key, write = true }));
        // Another window of the run holds the write control: still gated.
        var dialog = new FakeNode("Window", "Find", "dlgFind", w.ProcessId);
        dialog.Child("Edit", "Search for", "txtFind");
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Desktop.Foreground = dialog;
        _h.Err("act", Act(Harness.T(new { automationId = "txtFind" }), "key", new { value = key }), RpcErrors.PolicyRefusedCode);
        // No write control anywhere in the run: no gate.
        _h.Desktop.Windows.Remove(w);
        _h.Ok("act", Act(Harness.T(new { automationId = "txtFind" }), "key", new { value = key }));
    }

    [Theory]
    [InlineData("Tab")]
    [InlineData("Shift+Tab")]
    [InlineData("Down")]
    [InlineData("left")]
    [InlineData("Home")]
    [InlineData("PageDown")]
    [InlineData("Escape")]
    public void Navigation_keys_need_no_write_flag(string key)
    {
        _h.BeginWithApp();
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = key }));
    }

    [Fact]
    public void An_open_menu_gates_arrows_and_enter()
    {
        var w = _h.BeginWithApp();
        var menu = new FakeNode("Menu", "Context", "", w.ProcessId);
        menu.Child("MenuItem", "Post", "mnuPostLine");
        _h.Desktop.Windows.Insert(0, menu);
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "Down" }), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "Enter" }), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "Home" }), RpcErrors.PolicyRefusedCode);
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = "Escape" }));
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = "Down", write = true }));
        // A drop-down menu inside the main window counts too.
        _h.Desktop.Windows.Remove(menu);
        _h.Ok("act", Act(Id("txtUser"), "key", new { value = "Down" }));
        w.Child("Menu", "File", "mnuFileDropDown");
        _h.Err("act", Act(Id("txtUser"), "key", new { value = "Down" }), RpcErrors.PolicyRefusedCode);
    }

    [Theory]
    [InlineData("type")]
    [InlineData("select")]
    [InlineData("check")]
    [InlineData("uncheck")]
    [InlineData("doubleClick")]
    [InlineData("key")]
    public void Repair_mode_refuses_everything_but_read_and_navigate(string action)
    {
        _h.BeginWithApp();
        object extra = action switch
        {
            "type" or "select" => new { mode = "repair", value = "x" },
            "key" => new { mode = "repair", value = "Tab" },
            _ => new { mode = "repair" },
        };
        var e = _h.Err("act", Act(Id("txtUser"), action, extra), RpcErrors.PolicyRefusedCode);
        Assert.Contains("repair", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void Repair_mode_clicks_only_tabs_list_items_and_tree_items_and_never_write_controls()
    {
        _h.BeginWithApp();
        _h.Ok("act", Act(Harness.T(new { name = "Row A" }), "click", new { mode = "repair" }));
        _h.Ok("act", Act(Id("txtUser"), "focus", new { mode = "repair" }));
        _h.Ok("act", Act(Id("lstResults"), "expand", new { mode = "repair" }));
        _h.Ok("act", Act(Id("txtUser"), "read", new { mode = "repair" }));
        _h.Err("act", Act(Id("btnSignIn"), "click", new { mode = "repair" }), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("btnPost"), "focus", new { mode = "repair", write = true }), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("txtUser"), "key", new { mode = "repair", value = "Ctrl+S", write = true }), RpcErrors.PolicyRefusedCode);
    }

    [Fact]
    public void Type_composes_segments_and_never_interprets_text()
    {
        _h.BeginWithApp();
        var segments = new object[] { new { exportDir = true }, new { text = "\\{{$exportDir}}.csv" } };
        _h.Ok("act", Act(Id("txtUser"), "type", new { segments }));
        Assert.Equal(_h.ExportDir + "\\{{$exportDir}}.csv", _h.Desktop.Performed[^1].Text);
        _h.Ok("act", Act(Id("txtUser"), "type", new { value = "{{$exportDir}}" }));
        Assert.Equal("{{$exportDir}}", _h.Desktop.Performed[^1].Text);
    }

    [Theory]
    [InlineData("""{ "action": "type" }""")]
    [InlineData("""{ "action": "type", "value": "a", "segments": [] }""")]
    [InlineData("""{ "action": "type", "segments": [{ "text": "a", "exportDir": true }] }""")]
    [InlineData("""{ "action": "type", "segments": [{ "exportDir": false }] }""")]
    [InlineData("""{ "action": "type", "segments": [{ "path": "x" }] }""")]
    [InlineData("""{ "action": "click", "value": "x" }""")]
    [InlineData("""{ "action": "click", "segments": [] }""")]
    [InlineData("""{ "action": "select" }""")]
    [InlineData("""{ "action": "key" }""")]
    [InlineData("""{ "action": "key", "value": "Ctrl+Banana" }""")]
    [InlineData("""{ "action": "fly" }""")]
    [InlineData("""{ "action": "click", "mode": "explore" }""")]
    [InlineData("""{ "action": "click", "write": "yes" }""")]
    public void Invalid_act_params_are_invalid_params(string json)
    {
        _h.BeginWithApp();
        var o = JsonNode.Parse(json)!.AsObject();
        o["runId"] = Harness.RunId;
        o["target"] = JsonNode.Parse("""{ "path": [{ "automationId": "txtUser" }] }""");
        o["timeoutMs"] = 0;
        _h.Err("act", o, RpcErrors.InvalidParams);
    }

    [Fact]
    public void Typed_values_never_appear_in_errors()
    {
        _h.BeginWithApp();
        const string typed = "typed-value-7f3a";
        var errors = new List<string>
        {
            _h.Err("act", Act(Id("btnPost"), "type", new { value = typed }), RpcErrors.PolicyRefusedCode).ToJsonString(),
            _h.Err("act", Act(Id("missing"), "type", new { value = typed }), RpcErrors.NotFoundCode).ToJsonString(),
            _h.Err("act", Act(Harness.T(new { controlType = "Button" }), "type", new { segments = new object[] { new { text = typed } } }), RpcErrors.NotUniqueCode).ToJsonString(),
        };
        _h.Desktop.OnPerform = _ => throw new RetryableActionException("the element stayed disabled");
        errors.Add(_h.Err("act", Act(Id("txtUser"), "type", new { value = typed }), RpcErrors.TimeoutCode).ToJsonString());
        _h.Desktop.OnPerform = _ => throw new InvalidOperationException(typed);
        errors.Add(_h.Err("act", Act(Id("txtUser"), "type", new { value = typed }), RpcErrors.InternalError).ToJsonString());
        foreach (var e in errors) Assert.DoesNotContain(typed, e);
    }

    [Fact]
    public void Reading_a_password_or_credential_field_is_refused()
    {
        _h.BeginWithApp();
        _h.Err("act", Act(Id("txtPassword"), "read"), RpcErrors.PolicyRefusedCode);
        _h.Err("act", Act(Id("txtApiKey"), "read"), RpcErrors.PolicyRefusedCode);
        Assert.Equal("clerk", _h.Ok("act", Act(Id("txtUser"), "read"))["text"]!.GetValue<string>());
    }

    [Fact]
    public void A_retryable_failure_becomes_timeout_after_the_timeout()
    {
        _h.BeginWithApp();
        var calls = 0;
        _h.Desktop.OnPerform = _ =>
        {
            if (++calls < 3) throw new RetryableActionException("the element is disabled");
            return null;
        };
        _h.Ok("act", Act(Id("btnSignIn"), "click", new { timeoutMs = 3000 }));
        Assert.Equal(3, calls);
    }

    [Fact]
    public void An_os_surface_in_the_foreground_is_ignored_and_the_run_window_brought_back()
    {
        var w = _h.BeginWithApp();
        _h.Processes.Names[4242] = "ShellExperienceHost.exe";
        _h.Desktop.Foreground = new FakeNode("Window", "New notification", "", 4242);
        _h.Ok("act", Act(Id("btnSignIn"), "click"));
        Assert.Same(w, _h.Desktop.Foreground);
    }

    [Fact]
    public void Another_app_that_keeps_the_foreground_is_refused()
    {
        _h.BeginWithApp();
        _h.Processes.Names[4343] = "mstsc.exe";
        _h.Desktop.Foreground = new FakeNode("Window", "Remote Desktop", "", 4343);
        _h.Desktop.CanBringToFront = false;
        var e = _h.Err("act", Act(Id("btnSignIn"), "click"), RpcErrors.PolicyRefusedCode);
        Assert.Contains("mstsc.exe", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
        _h.Desktop.CanBringToFront = true;
        _h.Ok("act", Act(Id("btnSignIn"), "click"));
    }

    [Fact]
    public void Snapshot_hides_password_and_credential_values_and_prunes()
    {
        var w = _h.BeginWithApp();
        w.Find("Row B").IsOffscreen = true;
        var r = _h.Ok("snapshot", new { runId = Harness.RunId });
        Assert.Equal("ERP Demo - Line items", r["window"]!["title"]!.GetValue<string>());
        Assert.Equal("ErpDemo.exe", r["window"]!["exe"]!.GetValue<string>());
        var nodes = r["nodes"]!.AsArray().Select(n => n!.AsObject()).ToList();
        var text = r.ToJsonString();
        Assert.DoesNotContain("should-never-leave", text);
        Assert.DoesNotContain("also-hidden", text);
        var pwd = nodes.Single(n => n["automationId"]!.GetValue<string>() == "txtPassword");
        Assert.True(pwd["valueHidden"]!.GetValue<bool>());
        Assert.Null(pwd["value"]);
        var user = nodes.Single(n => n["automationId"]!.GetValue<string>() == "txtUser");
        Assert.Equal("clerk", user["value"]!.GetValue<string>());
        Assert.Null(user["valueHidden"]);
        // The unnamed Pane is flattened: its button sits at depth 1, directly under the window.
        Assert.DoesNotContain(nodes, n => n["controlType"]!.GetValue<string>() == "Pane");
        Assert.Equal(1, nodes.Single(n => n["automationId"]!.GetValue<string>() == "btnInner")["depth"]!.GetValue<int>());
        Assert.DoesNotContain(nodes, n => n["name"]!.GetValue<string>() == "Row B");
        Assert.Equal(nodes.Count, nodes.Select(n => n["ref"]!.GetValue<string>()).Distinct().Count());
        foreach (var n in nodes)
            foreach (var key in new[] { "ref", "depth", "controlType", "name", "automationId", "className", "enabled" })
                Assert.NotNull(n[key]);
    }

    [Fact]
    public void Snapshot_respects_max_nodes_and_max_depth()
    {
        _h.BeginWithApp();
        var r = _h.Ok("snapshot", new { runId = Harness.RunId, maxNodes = 3 });
        Assert.Equal(3, r["nodes"]!.AsArray().Count);
        Assert.True(r["truncated"]!.GetValue<bool>());
        var shallow = _h.Ok("snapshot", new { runId = Harness.RunId, maxDepth = 1 });
        Assert.All(shallow["nodes"]!.AsArray(), n => Assert.True(n!["depth"]!.GetValue<int>() <= 1));
        Assert.DoesNotContain(shallow["nodes"]!.AsArray(), n => n!["name"]!.GetValue<string>() == "Row A");
    }

    [Fact]
    public void Snapshot_of_a_window_selector_and_screenshot_of_the_current_window()
    {
        _h.BeginWithApp();
        _h.Err("snapshot", new { runId = Harness.RunId, window = new { title = "Nope" } }, RpcErrors.NotFoundCode);
        var shot = _h.Ok("screenshot", new { runId = Harness.RunId });
        Assert.Equal("iVBORw==", shot["base64"]!.GetValue<string>());
    }

    [Fact]
    public void File_retrieve_returns_the_file_from_the_export_dir()
    {
        _h.Begin();
        File.WriteAllText(Path.Combine(_h.ExportDir!, "line-items.csv"), "a,b\n1,2\n");
        var r = _h.Ok("file.retrieve", new { runId = Harness.RunId, pattern = "^line-items\\.csv$", timeoutMs = 2000, maxBytes = 1000 });
        Assert.Equal("line-items.csv", r["name"]!.GetValue<string>());
        Assert.Equal(8, r["size"]!.GetValue<long>());
        Assert.Equal("a,b\n1,2\n", System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(r["base64"]!.GetValue<string>())));
    }

    [Fact]
    public void File_retrieve_reports_a_missing_file_and_never_names_the_typed_file()
    {
        _h.Begin();
        var e = _h.Err("file.retrieve", new { runId = Harness.RunId, pattern = "\\.csv$", timeoutMs = 300, maxBytes = 1000 }, RpcErrors.ExpectedFileMissingCode);
        Assert.Equal("expected_file_missing", e["data"]!["name"]!.GetValue<string>());
        File.WriteAllText(Path.Combine(_h.ExportDir!, "secret-name.csv"), new string('x', 2000));
        var big = _h.Err("file.retrieve", new { runId = Harness.RunId, pattern = "\\.csv$", timeoutMs = 2000, maxBytes = 1000000 }, RpcErrors.PolicyRefusedCode);
        Assert.DoesNotContain("secret-name", big.ToJsonString());
        Assert.Contains("1024", big["message"]!.GetValue<string>()); // the policy's limit wins over the caller's
    }

    [Fact]
    public void File_retrieve_ignores_subdirectories_and_invalid_patterns_are_invalid_params()
    {
        _h.Begin();
        var sub = Directory.CreateDirectory(Path.Combine(_h.ExportDir!, "sub")).FullName;
        File.WriteAllText(Path.Combine(sub, "deep.csv"), "x");
        _h.Err("file.retrieve", new { runId = Harness.RunId, pattern = "deep", timeoutMs = 300, maxBytes = 100 }, RpcErrors.ExpectedFileMissingCode);
        _h.Err("file.retrieve", new { runId = Harness.RunId, pattern = "(", timeoutMs = 300, maxBytes = 100 }, RpcErrors.InvalidParams);
    }

    [Fact]
    public async Task Json_rpc_framing_errors()
    {
        Assert.Contains("-32700", (await _h.Dispatcher.HandleAsync("{nope", default)));
        Assert.Contains("-32600", (await _h.Dispatcher.HandleAsync("[]", default)));
        Assert.Contains("-32600", (await _h.Dispatcher.HandleAsync("""{"id":1,"method":"hello"}""", default)));
        Assert.Contains("-32601", (await _h.Dispatcher.HandleAsync("""{"jsonrpc":"2.0","id":1,"method":"nope"}""", default)));
        Assert.Contains("\"id\":\"abc\"", (await _h.Dispatcher.HandleAsync("""{"jsonrpc":"2.0","id":"abc","method":"hello"}""", default)));
        Assert.Null((await _h.Dispatcher.HandleAsync("""{"jsonrpc":"2.0","method":"hello"}""", default)));
    }
}
