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
        foreach (var m in new[] { "run.heartbeat", "run.end", "app.launch", "snapshot", "isVisible", "resolve", "act", "windows", "file.retrieve", "screenshot", "clipboard.read" })
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
    public void Repair_mode_allows_Escape_without_target()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        // A menu drop-down of the main window is open (the main window holds a write control, so Escape needs it).
        var dropDown = new FakeNode("Menu", "Reports", "", w.ProcessId) { Owner = w };
        dropDown.Child("MenuItem", "Export line items...");
        _h.Desktop.Windows.Add(dropDown);
        var r = _h.Ok("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 });
        Assert.Empty(r.AsObject());
        var op = Assert.Single(_h.Desktop.Performed);
        Assert.Equal("Escape", op.Key!.ToString());
        Assert.Equal("txtUser", op.Element.AutomationId);
    }

    [Fact]
    public void Repair_mode_refuses_Escape_with_the_focus_on_a_write_control()
    {
        var w = _h.BeginWithApp();
        // A drop-down of the window is open, so only the focused element's own check can refuse.
        _h.Desktop.Windows.Add(new FakeNode("Menu", "Reports", "", w.ProcessId) { Owner = w });
        _h.Desktop.Focused = w.Find("btnPost");
        var e = _h.Err("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 }, RpcErrors.PolicyRefusedCode);
        Assert.Equal("policy_refused: the target is a declared write control; repair mode never acts on it", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_on_a_window_with_a_write_control_needs_an_open_menu()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        var e = _h.Err("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 }, RpcErrors.PolicyRefusedCode);
        Assert.Equal("policy_refused: in repair mode Escape could press a declared write control of this window (a cancel button), so it is allowed only while a menu is open",
            e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
        // With a popup menu owned by the window open, Escape only closes the menu.
        var dropDown = new FakeNode("Menu", "Reports", "", w.ProcessId) { Owner = w };
        dropDown.Child("MenuItem", "Export line items...");
        _h.Desktop.Windows.Insert(0, dropDown);
        _h.Ok("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 });
        Assert.Same(w, Assert.Single(_h.Desktop.Performed).Window);
    }

    private static object RepairEscape => new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 };

    [Fact]
    public void Repair_mode_Escape_does_not_count_a_menu_bar_as_an_open_menu()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        var bar = new FakeNode("MenuBar", "Application", "mainMenu");
        bar.Child("MenuItem", "Reports");
        w.Add(bar);
        w.Child("Menu", "Reports", "mnuReportsDropDown");
        var e = _h.Err("act", RepairEscape, RpcErrors.PolicyRefusedCode);
        Assert.Contains("allowed only while a menu is open", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_needs_the_popup_menu_to_belong_to_its_window()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        // A popup menu of another run window (not the foreground, not owned by the main window).
        var other = new FakeNode("Window", "Find", "dlgFind", w.ProcessId);
        _h.Desktop.Windows.Add(other);
        _h.Desktop.Windows.Insert(0, new FakeNode("Menu", "Context", "", w.ProcessId) { Owner = other });
        _h.Err("act", RepairEscape, RpcErrors.PolicyRefusedCode);
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_fails_closed_when_the_popup_cannot_be_read()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        _h.Desktop.Windows.Insert(0, new FakeNode("Menu", "Reports", "", w.ProcessId) { Owner = w, Gone = true });
        _h.Err("act", RepairEscape, RpcErrors.PolicyRefusedCode);
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_allows_a_win32_popup_menu_owned_by_its_window()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        _h.Desktop.Windows.Insert(0, new FakeNode("Pane", "", "", w.ProcessId) { ClassName = "#32768", Owner = w });
        _h.Ok("act", RepairEscape);
        Assert.Single(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_is_refused_when_the_popup_closes_before_the_key_is_sent()
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        var dropDown = new FakeNode("Menu", "Reports", "", w.ProcessId) { Owner = w };
        _h.Desktop.Windows.Insert(0, dropDown);
        _h.Desktop.BeforeInput = _ => _h.Desktop.Windows.Remove(dropDown);
        var e = _h.Err("act", RepairEscape, RpcErrors.PolicyRefusedCode);
        Assert.Contains("allowed only while a menu is open", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_Escape_reaches_a_dialog_the_run_window_owns()
    {
        var main = _h.BeginWithApp();
        // UI Automation nests an owned dialog under its owner, while the window manager lists it as a top-level window.
        var dialog = new FakeNode("Window", "Confirm export", "ConfirmExportForm");
        dialog.Child("Button", "Continue", "btnConfirmExport");
        main.Add(dialog);
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Desktop.Foreground = dialog;
        _h.Desktop.Focused = dialog.Find("btnConfirmExport");
        _h.Ok("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 });
        var op = Assert.Single(_h.Desktop.Performed);
        Assert.Same(dialog, op.Window);
    }

    [Fact]
    public void Repair_mode_Escape_is_refused_when_its_window_cannot_be_read()
    {
        var main = _h.BeginWithApp();
        // The foreground dialog as the Windows driver returns a window UI Automation could not wrap (HwndNode): its
        // contents cannot be searched, so it may hold a write control that Escape presses.
        var dialog = new FakeNode("Window", "Confirm export", "ConfirmExportForm") { Unreadable = true };
        dialog.Child("Button", "Continue", "btnConfirmExport");
        main.Add(dialog);
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Desktop.Foreground = dialog;
        _h.Desktop.Focused = dialog.Find("btnConfirmExport");
        var e = _h.Err("act", RepairEscape, RpcErrors.PolicyRefusedCode);
        Assert.Contains("allowed only while a menu is open", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Theory]
    [InlineData("Enter", false)]
    [InlineData("Tab", false)]
    [InlineData("Down", false)]
    [InlineData("Shift+Escape", false)]
    [InlineData("Escape", true)]
    public void Repair_mode_refuses_other_keys(string key, bool withTarget)
    {
        var w = _h.BeginWithApp();
        _h.Desktop.Focused = w.Find("txtUser");
        object p = withTarget
            ? Act(Id("txtUser"), "key", new { value = key, mode = "repair" })
            : new { runId = Harness.RunId, action = "key", value = key, mode = "repair", timeoutMs = 0 };
        var e = _h.Err("act", p, RpcErrors.PolicyRefusedCode);
        // The wire message is "<error name>: <reason>".
        Assert.StartsWith("policy_refused: repair mode allows only", e["message"]!.GetValue<string>());
        Assert.Empty(_h.Desktop.Performed);
    }

    [Fact]
    public void Repair_mode_refuses_gated_Escape()
    {
        using var probe = new Harness();
        using var h = new Harness($$"""
            { "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{System.Text.Json.JsonSerializer.Serialize(probe.AppPath)}} }], "gatedKeys": ["Escape"] }
            """);
        var w = h.BeginWithApp();
        h.Desktop.Focused = w.Find("txtUser");
        var e = h.Err("act", new { runId = Harness.RunId, action = "key", value = "Escape", mode = "repair", timeoutMs = 0 }, RpcErrors.PolicyRefusedCode);
        Assert.Equal("policy_refused: the gated key Escape is never allowed in repair mode", e["message"]!.GetValue<string>());
        Assert.Empty(h.Desktop.Performed);
    }

    [Fact]
    public void Windows_lists_run_windows_foreground_first()
    {
        var main = _h.BeginWithApp();
        main.ClassName = "WindowsForms10.Window.8.app";
        var dialog = new FakeNode("Window", "Confirm export", "ConfirmForm", main.ProcessId) { ClassName = "WindowsForms10.Window.8.app.dlg" };
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Desktop.Foreground = dialog;
        var list = _h.Ok("windows", new { runId = Harness.RunId })["windows"]!.AsArray();
        Assert.Equal(2, list.Count);
        Assert.Equal("Confirm export", list[0]!["title"]!.GetValue<string>());
        Assert.Equal("ErpDemo.exe", list[0]!["exe"]!.GetValue<string>());
        Assert.Equal("ConfirmForm", list[0]!["automationId"]!.GetValue<string>());
        Assert.Equal("WindowsForms10.Window.8.app.dlg", list[0]!["className"]!.GetValue<string>());
        Assert.True(list[0]!["foreground"]!.GetValue<bool>());
        Assert.Equal("ERP Demo - Line items", list[1]!["title"]!.GetValue<string>());
        Assert.Equal("MainForm", list[1]!["automationId"]!.GetValue<string>());
        Assert.False(list[1]!["foreground"]!.GetValue<bool>());
        // The foreground window comes first even when it is not front-most; the rest stay in z-order.
        _h.Desktop.Foreground = main;
        list = _h.Ok("windows", new { runId = Harness.RunId })["windows"]!.AsArray();
        Assert.Equal(["ERP Demo - Line items", "Confirm export"], list.Select(n => n!["title"]!.GetValue<string>()));
        Assert.Equal([true, false], list.Select(n => n!["foreground"]!.GetValue<bool>()));
        // At most 20.
        for (var i = 0; i < 25; i++) _h.Desktop.Windows.Add(new FakeNode("Window", $"Extra {i}", "", main.ProcessId));
        Assert.Equal(20, _h.Ok("windows", new { runId = Harness.RunId })["windows"]!.AsArray().Count);
    }

    [Fact]
    public void Windows_never_lists_other_processes()
    {
        _h.BeginWithApp();
        _h.Processes.Names[777] = "notepad.exe";
        var foreign = new FakeNode("Window", "Untitled - Notepad", "", 777);
        _h.Desktop.Windows.Insert(0, foreign);
        _h.Desktop.Foreground = foreign;
        var list = _h.Ok("windows", new { runId = Harness.RunId })["windows"]!.AsArray();
        var only = Assert.Single(list);
        Assert.Equal("ERP Demo - Line items", only!["title"]!.GetValue<string>());
        Assert.False(only["foreground"]!.GetValue<bool>());
        Assert.DoesNotContain("Notepad", list.ToJsonString());
    }

    [Fact]
    public void Windows_needs_active_run()
    {
        _h.BeginWithApp();
        var e = _h.Err("windows", new { runId = "other" }, RpcErrors.NoRunCode);
        Assert.Equal("no_run", e["data"]!["name"]!.GetValue<string>());
        _h.Desktop.Session = new SessionState(true, true, true);
        _h.Err("windows", new { runId = Harness.RunId }, RpcErrors.DesktopUnavailableCode);
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

    // Helper processes (policy helperProcesses): a WebView2 app's UI lives in msedgewebview2.exe children of the app.

    /// <summary>The run's main window with a web view pane hosted by another process, holding a "Copy (ops.bot)" button.</summary>
    private static (FakeNode Window, FakeNode Copy) WithWebView(Harness h, int helperPid)
    {
        var w = h.BeginWithApp();
        var view = new FakeNode("Pane", "Authenticator", "", helperPid);
        var copy = new FakeNode("Button", "Copy (ops.bot)", "", helperPid);
        view.Add(copy);
        w.Add(view);
        return (w, copy);
    }

    private static object CopyButton() => Harness.T(new { controlType = "Button", name = "Copy (ops.bot)" });

    [Fact]
    public void A_helper_process_counts_as_the_runs_only_when_it_descends_from_a_process_the_run_launched()
    {
        using var h = new Harness(helpers: true);
        var (_, copy) = WithWebView(h, 2000);
        var app = h.Processes.Names.Keys.Single(k => k != 2000);
        h.Processes.Names[2000] = "msedgewebview2.exe";
        h.Processes.Paths[2000] = h.HelperPath();
        h.Processes.Parents[2000] = app;

        // A descendant on the pattern's path: its elements resolve, and input may land on them.
        h.Ok("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 });
        h.Desktop.InputReceiver = copy;
        h.Ok("act", Act(CopyButton(), "click"));

        // Another version folder matches the one star segment too.
        h.Processes.Paths[2000] = h.HelperPath("157.0.1.2");
        h.Ok("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 });

        // The same executable started by something else (not a descendant): never the run's.
        h.Processes.Parents[2000] = 3000;
        h.Err("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 }, RpcErrors.NotFoundCode);
        var e = h.Err("act", Act(CopyButton(), "click"), RpcErrors.NotFoundCode);
        Assert.Contains("Copy (ops.bot)", e["message"]!.GetValue<string>());

        // A descendant from a path outside the pattern: never the run's.
        h.Processes.Parents[2000] = app;
        h.Processes.Paths[2000] = Path.Combine(h.Root, "EdgeWebView", "Application", "156.0", "sub", "msedgewebview2.exe");
        h.Err("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 }, RpcErrors.NotFoundCode);
        h.Processes.Paths[2000] = Path.Combine(h.Root, "Downloads", "156.0", "msedgewebview2.exe");
        h.Err("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 }, RpcErrors.NotFoundCode);
    }

    [Fact]
    public void Without_helper_processes_in_the_policy_a_web_view_child_is_another_application()
    {
        var (_, copy) = WithWebView(_h, 2000);
        var app = _h.Processes.Names.Keys.Single(k => k != 2000);
        _h.Processes.Names[2000] = "msedgewebview2.exe";
        _h.Processes.Paths[2000] = _h.HelperPath();
        _h.Processes.Parents[2000] = app;
        _h.Err("resolve", new { runId = Harness.RunId, target = CopyButton(), timeoutMs = 0 }, RpcErrors.NotFoundCode);
        // Input that would land on it (a click on the run's own control that the web view covers) is refused.
        _h.Desktop.InputReceiver = copy;
        var e = _h.Err("act", Act(Id("btnSignIn"), "click"), RpcErrors.PolicyRefusedCode);
        Assert.Contains("another application", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void A_helper_window_of_the_run_is_listed_and_one_of_another_process_is_not()
    {
        using var h = new Harness(helpers: true);
        h.BeginWithApp();
        var app = h.Processes.Names.Keys.Single();
        foreach (var (pid, parent) in new[] { (2000, app), (2001, 9999) })
        {
            h.Processes.Names[pid] = "msedgewebview2.exe";
            h.Processes.Paths[pid] = h.HelperPath();
            h.Processes.Parents[pid] = parent;
            h.Desktop.Windows.Add(new FakeNode("Window", $"web view {pid}", "", pid));
        }
        var titles = h.Ok("windows", new { runId = Harness.RunId })["windows"]!.AsArray().Select(w => w!["title"]!.GetValue<string>()).ToList();
        Assert.Contains("web view 2000", titles);
        Assert.DoesNotContain("web view 2001", titles);
    }

    // clipboard.read (policy clipboardRead).

    private const string Code = "988 374";

    [Fact]
    public void Clipboard_read_is_refused_without_the_policy_flag_and_never_touches_the_clipboard()
    {
        _h.BeginWithApp();
        _h.Desktop.ClipboardText = Code;
        var e = _h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("clipboardRead", e["message"]!.GetValue<string>());
        Assert.DoesNotContain(Code, e.ToJsonString());
        Assert.Equal(0, _h.Desktop.ClipboardReads);
    }

    [Fact]
    public void Clipboard_read_is_refused_while_another_application_holds_the_foreground()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true");
        var w = h.BeginWithApp();
        h.Desktop.ClipboardText = Code;
        h.Processes.Names[777] = "notepad.exe";
        h.Processes.Paths[777] = Path.Combine(h.Root, "Windows", "notepad.exe");
        h.Desktop.Foreground = new FakeNode("Window", "Untitled - Notepad", "", 777);
        var e = h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("foreground", e["message"]!.GetValue<string>());
        Assert.DoesNotContain(Code, e.ToJsonString());
        // Never brought back for a clipboard read: the text on the clipboard may be the other application's.
        Assert.NotSame(w, h.Desktop.Foreground);
        // No foreground window at all, and an OS surface in front, are refused too.
        h.Desktop.Foreground = null;
        h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
        h.Processes.Names[4242] = "ShellExperienceHost.exe";
        h.Desktop.Foreground = new FakeNode("Window", "New notification", "", 4242);
        h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
        Assert.Equal(0, h.Desktop.ClipboardReads);
    }

    [Fact]
    public void Clipboard_read_returns_the_text_while_a_run_window_is_in_front_and_never_logs_it()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true", fileLog: true);
        h.BeginWithApp();
        h.Desktop.ClipboardText = Code + " \u00fc\u20ac";
        var r = h.Ok("clipboard.read", new { runId = Harness.RunId });
        Assert.Equal(Code + " \u00fc\u20ac", r["text"]!.GetValue<string>());
        Assert.Contains("clipboard.read", h.LogText());
        Assert.DoesNotContain(Code, h.LogText());
        // No text on the clipboard reads as empty text.
        h.Desktop.ClipboardText = null;
        Assert.Equal("", h.Ok("clipboard.read", new { runId = Harness.RunId })["text"]!.GetValue<string>());
    }

    [Fact]
    public void Clipboard_read_with_a_helper_window_in_front_of_a_web_view_app()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true", helpers: true);
        var (_, copy) = WithWebView(h, 2000);
        var app = h.Processes.Names.Keys.Single(k => k != 2000);
        h.Processes.Names[2000] = "msedgewebview2.exe";
        h.Processes.Paths[2000] = h.HelperPath();
        h.Processes.Parents[2000] = app;
        h.Desktop.InputReceiver = copy;
        h.Desktop.OnPerform = op => { if (ReferenceEquals(op.Element, copy)) h.Desktop.ClipboardText = Code; return null; };
        h.Ok("act", Act(CopyButton(), "click"));
        Assert.Equal(Code, h.Ok("clipboard.read", new { runId = Harness.RunId })["text"]!.GetValue<string>());
        // A helper's own top-level window in front counts as the run's while the helper descends from the run.
        var helperWindow = new FakeNode("Window", "web view", "", 2000);
        h.Desktop.Windows.Insert(0, helperWindow);
        h.Desktop.Foreground = helperWindow;
        Assert.Equal(Code, h.Ok("clipboard.read", new { runId = Harness.RunId })["text"]!.GetValue<string>());
        h.Processes.Parents[2000] = 9999;
        h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
    }

    [Fact]
    public void Clipboard_read_refuses_more_than_1000_characters_without_returning_any()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true");
        h.BeginWithApp();
        h.Desktop.ClipboardText = new string('7', RunnerService.MaxClipboardChars);
        Assert.Equal(RunnerService.MaxClipboardChars, h.Ok("clipboard.read", new { runId = Harness.RunId })["text"]!.GetValue<string>().Length);
        h.Desktop.ClipboardText = new string('7', RunnerService.MaxClipboardChars + 1);
        var e = h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.PolicyRefusedCode);
        Assert.Contains("1000", e["message"]!.GetValue<string>());
        Assert.DoesNotContain("7777", e.ToJsonString());
    }

    [Fact]
    public void Clipboard_read_retries_a_busy_clipboard_then_times_out()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true");
        h.BeginWithApp();
        h.Desktop.ClipboardText = Code;
        h.Desktop.ClipboardBusy = 2;
        Assert.Equal(Code, h.Ok("clipboard.read", new { runId = Harness.RunId })["text"]!.GetValue<string>());
        Assert.Equal(3, h.Desktop.ClipboardReads);
        h.Desktop.ClipboardBusy = int.MaxValue;
        var e = h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.TimeoutCode);
        Assert.Contains("clipboard", e["message"]!.GetValue<string>());
    }

    [Fact]
    public void Clipboard_read_needs_the_active_run_and_a_usable_desktop()
    {
        using var h = new Harness(policyExtra: ", \"clipboardRead\": true");
        h.Desktop.ClipboardText = Code;
        h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.NoRunCode);
        h.BeginWithApp();
        h.Err("clipboard.read", new { runId = "other" }, RpcErrors.NoRunCode);
        h.Desktop.Session = new SessionState(true, true, true);
        h.Err("clipboard.read", new { runId = Harness.RunId }, RpcErrors.DesktopUnavailableCode);
        Assert.Equal(0, h.Desktop.ClipboardReads);
    }
}
