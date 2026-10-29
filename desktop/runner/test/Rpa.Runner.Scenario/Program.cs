using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Rpa.Runner.Scenario;

// Drives the ERP Demo through a running RPA desktop runner, as n8n would, and checks every result.
//   Rpa.Runner.Scenario --url wss://127.0.0.1:8765/rpa/v1 --fingerprint AB:CD:... --app C:\...\v1\ErpDemo.exe
//                       --app-v2 C:\...\v2\ErpDemo.exe --out <dir>
// The token comes from RPA_RUNNER_TOKEN. Exit code 0 when every check passed.
var opts = new Dictionary<string, string>();
for (var i = 0; i + 1 < args.Length; i += 2) opts[args[i]] = args[i + 1];
string Opt(string k) => opts.TryGetValue(k, out var v) ? v : throw new ArgumentException($"missing {k}");
var token = Environment.GetEnvironmentVariable("RPA_RUNNER_TOKEN") ?? throw new ArgumentException("RPA_RUNNER_TOKEN is not set");
var scenario = new Scenario(new Uri(Opt("--url")), token, Opt("--fingerprint"), Opt("--app"), Opt("--app-v2"), Opt("--out"));
return await scenario.RunAsync();

internal sealed class Scenario(Uri url, string token, string fingerprint, string appPath, string appV2Path, string outDir)
{
    private const string LoginTitle = "ERP Demo - Sign in";
    private const string MainTitle = "ERP Demo - Line items";
    private const string SaveTitle = "Export line items";
    private const string Password = "demo1234";

    private static readonly string[] ExpectedCsv =
    [
        "Document,Date,Company,Vendor,Amount,Currency,Status",
        "1000-0001,2026-01-05,1000,Granite Tools,189.19,EUR,Cleared",
        "1000-0002,2026-01-28,1000,Harbor Foods,268.38,EUR,Blocked",
        "1000-0003,2026-02-20,1000,Summit Energy,347.57,EUR,Open",
        "1000-0004,2026-03-15,1000,Acme Paper Co,426.76,EUR,Cleared",
        "1000-0005,2026-04-07,1000,Blue River Logistics,505.95,EUR,Blocked",
        "1000-0006,2026-04-30,1000,Granite Tools,585.14,EUR,Open",
        "1000-0007,2026-05-23,1000,Harbor Foods,664.33,EUR,Cleared",
        "1000-0008,2026-06-15,1000,Summit Energy,743.52,EUR,Blocked",
        "1000-0009,2026-07-08,1000,Acme Paper Co,822.71,EUR,Open",
        "1000-0010,2026-07-31,1000,Blue River Logistics,901.90,EUR,Cleared",
        "1000-0011,2026-08-23,1000,Granite Tools,981.09,EUR,Blocked",
        "1000-0012,2026-09-15,1000,Harbor Foods,1060.28,EUR,Open",
    ];

    private readonly List<(string Name, bool Ok, string? Detail)> _results = [];
    private RpcClient _rpc = null!;
    private string _runId = "";

    public async Task<int> RunAsync()
    {
        Directory.CreateDirectory(outDir);
        _rpc = await RpcClient.ConnectAsync(url, token, fingerprint);
        try
        {
            await MainFlow();
            await V2Smoke();
            await V2Repair();
            await LeaseExpiry();
            await WrongToken();
        }
        finally
        {
            await _rpc.DisposeAsync();
        }
        Console.WriteLine();
        Console.WriteLine($"{_results.Count(r => r.Ok)} passed, {_results.Count(r => !r.Ok)} failed");
        return _results.All(r => r.Ok) ? 0 : 1;
    }

    private async Task MainFlow()
    {
        _runId = "scenario-" + Guid.NewGuid().ToString("N")[..8];
        string exportDir = "";
        var pid = 0;
        var ok = await Step("hello reports protocol 1 and an interactive, unlocked session", async () =>
        {
            var r = await Call("hello");
            Expect(r["protocol"]!.GetValue<int>() == 1, "protocol is 1");
            Console.WriteLine($"    runner {r["runner"]!["version"]} on {r["runner"]!["os"]}");
            Expect(r["runner"]!["session"]!["interactive"]!.GetValue<bool>(), "session.interactive");
            Expect(!r["runner"]!["session"]!["locked"]!.GetValue<bool>(), "session not locked");
        });
        ok &= await Step("run.begin returns a fresh, empty export dir", async () =>
        {
            exportDir = (await Call("run.begin", new { runId = _runId, leaseMs = 120000 }))["exportDir"]!.GetValue<string>();
            Expect(Path.IsPathFullyQualified(exportDir) && Directory.Exists(exportDir), "the export dir exists");
            Expect(Directory.GetFileSystemEntries(exportDir).Length == 0, "the export dir is empty");
        });
        if (!ok) return;
        try
        {
            await Step("a second run.begin is runner_busy (-32001)", () =>
                ExpectError(-32001, () => Call("run.begin", new { runId = "other", leaseMs = 10000 })));
            await Step("app.launch of an app outside the policy is policy_refused (-32003)", () =>
                ExpectError(-32003, () => Call("app.launch", new { runId = _runId, app = new { exe = @"C:\Windows\System32\notepad.exe" } })));

            ok = await Step("app.launch starts ErpDemo.exe", async () =>
            {
                pid = (await Call("app.launch", new { runId = _runId, app = new { exe = appPath } }))["pid"]!.GetValue<int>();
                Expect(pid > 0, "pid");
            });
            ok &= await Step("the sign-in window appears and UI Automation sees its controls", async () =>
            {
                await Call("resolve", new { runId = _runId, target = TW(LoginTitle, new { automationId = "txtUser" }), timeoutMs = 30000 });
                await SaveSnapshot("snapshot-login.json", new { title = LoginTitle });
            });
            if (!ok) return;

            ok = await Step("sign in: type user and password, click Sign in", async () =>
            {
                await Act(TW(LoginTitle, new { automationId = "txtUser" }), "type", new { value = "clerk" });
                await Act(TW(LoginTitle, new { automationId = "txtPassword" }), "type", new { value = Password });
                var snap = await SaveSnapshot("snapshot-login-filled.json", new { title = LoginTitle });
                var pwd = snap["nodes"]!.AsArray().First(n => n!["automationId"]!.GetValue<string>() == "txtPassword")!;
                Expect(pwd["valueHidden"]?.GetValue<bool>() == true && pwd["value"] is null, "the password field's value is hidden");
                Expect(!snap.ToJsonString().Contains(Password, StringComparison.Ordinal), "the password never appears in a snapshot");
                await ExpectError(-32003, () => Act(TW(LoginTitle, new { automationId = "txtPassword" }), "read"));
                await Act(TW(LoginTitle, new { automationId = "btnSignIn" }), "click");
                await Call("resolve", new { runId = _runId, target = TW(MainTitle, new { automationId = "cmbCompany" }), timeoutMs = 15000 });
            });
            if (!ok) return;
            await SaveSnapshot("snapshot-main.json", new { title = MainTitle });

            await Step("a write control without write: true is policy_refused (-32003)", () =>
                ExpectError(-32003, () => Act(TW(MainTitle, new { automationId = "btnPost" }), "click")));
            await Step("a gated key without write: true is policy_refused (-32003)", () =>
                ExpectError(-32003, () => Act(TW(MainTitle, new { automationId = "txtDateFrom" }), "key", new { value = "Ctrl+S" })));
            await Step("repair mode refuses type (-32003)", () =>
                ExpectError(-32003, () => Act(TW(MainTitle, new { automationId = "txtDateFrom" }), "type", new { value = "x", mode = "repair" })));
            await Step("not_found (-32004) names the target and the window title", async () =>
            {
                var e = await ExpectError(-32004, () => Call("resolve", new { runId = _runId, target = TW(MainTitle, new { automationId = "btnDoesNotExist" }), timeoutMs = 500 }));
                Expect(e.RunnerMessage.Contains("btnDoesNotExist", StringComparison.Ordinal), "message names the target");
                Expect(e.RunnerMessage.Contains(MainTitle, StringComparison.Ordinal), "message names the window title");
            });
            await Step("not_unique (-32005) gives the count", async () =>
            {
                var e = await ExpectError(-32005, () => Call("resolve", new { runId = _runId, target = TW(MainTitle, new { controlType = "Edit" }), timeoutMs = 0 }));
                Expect(System.Text.RegularExpressions.Regex.IsMatch(e.RunnerMessage, @"matched \d+ visible"), "message gives N");
            });

            ok = await Step("search company 1000: select, click Search, 12 results", async () =>
            {
                await Act(TW(MainTitle, new { automationId = "cmbCompany" }), "select", new { value = "1000" });
                await Act(TW(MainTitle, new { automationId = "btnSearch" }), "click");
                var count = await Read(TW(MainTitle, new { automationId = "lblResultCount" }));
                Expect(count == "12 line items", $"result count is \"12 line items\" (got \"{count}\")");
            });
            if (!ok) return;
            await SaveSnapshot("snapshot-results.json", new { title = MainTitle }, maxNodes: 1500);

            await Step("read the first row", async () =>
            {
                var detail = await Read(TW(MainTitle, new { automationId = "txtDetail" }));
                Expect(detail == "1000-0001 2026-01-05 Granite Tools 189.19 EUR Cleared", $"detail of row 1 (got \"{detail}\")");
                var cell = await Read(new
                {
                    window = new { title = MainTitle },
                    path = new object[] { new { automationId = "gridResults" }, new { name = "Document Row 0" } },
                    fallbacks = new object[]
                    {
                        new { window = new { title = MainTitle }, path = new object[] { new { automationId = "gridResults" }, new { name = "Row 0" }, new { name = "Document Row 0" } } },
                        new { window = new { title = MainTitle }, path = new object[] { new { automationId = "gridResults" }, new { name = "Row 0" }, new { index = 0, controlType = "DataItem" } } },
                    },
                });
                Expect(cell == "1000-0001", $"the first grid cell is 1000-0001 (got \"{cell}\")");
            });

            ok = await Step("export via File > Export... to {exportDir} with segments", async () =>
            {
                // WinForms menu items expose no automation id, so menus are found by name.
                await Act(TW(MainTitle, new { controlType = "MenuItem", name = "File" }), "click");
                await Act(T(new { controlType = "MenuItem", name = "Export..." }), "click", timeoutMs: 5000);
                await Call("resolve", new { runId = _runId, target = TW(SaveTitle, new { automationId = "1001", controlType = "Edit" }), timeoutMs = 15000 });
                await SaveSnapshot("snapshot-save-dialog.json", new { title = SaveTitle }, maxNodes: 1500);
                await Act(TW(SaveTitle, new { automationId = "1001", controlType = "Edit" }), "type",
                    new { segments = new object[] { new { exportDir = true }, new { text = @"\line-items.csv" } } });
                await Act(TW(SaveTitle, new { automationId = "1", controlType = "Button" }), "click");
            });
            if (!ok) return;

            await Step("file.retrieve returns the CSV with the exact rows", async () =>
            {
                var f = await Call("file.retrieve", new { runId = _runId, pattern = @"^line-items\.csv$", timeoutMs = 15000, maxBytes = 1048576 });
                Expect(f["name"]!.GetValue<string>() == "line-items.csv", "name");
                var bytes = Convert.FromBase64String(f["base64"]!.GetValue<string>());
                Expect(f["size"]!.GetValue<long>() == bytes.Length, "size matches the bytes");
                var text = Encoding.UTF8.GetString(bytes);
                File.WriteAllText(Path.Combine(outDir, "line-items.csv"), text);
                var expected = string.Join("\r\n", ExpectedCsv) + "\r\n";
                Expect(text == expected, "the CSV matches the expected 12 rows exactly");
                await ExpectError(-32006, () => Call("file.retrieve", new { runId = _runId, pattern = @"^nothing\.csv$", timeoutMs = 500, maxBytes = 1048576 }));
            });

            await Step("screenshot returns a PNG of the run's window", async () =>
            {
                var png = Convert.FromBase64String((await Call("screenshot", new { runId = _runId }))["base64"]!.GetValue<string>());
                Expect(png.Length > 100 && png[0] == 0x89 && png[1] == 'P', "PNG signature");
                File.WriteAllBytes(Path.Combine(outDir, "screenshot-main.png"), png);
            });

            await Step("a write control with write: true acts (Post)", async () =>
            {
                await Act(TW(MainTitle, new { automationId = "btnPost" }), "click", new { write = true });
                var detail = await Read(TW(MainTitle, new { automationId = "txtDetail" }));
                Expect(detail.EndsWith(" Posted", StringComparison.Ordinal), $"the first row is posted (got \"{detail}\")");
            });
        }
        finally
        {
            if (_results.Any(r => !r.Ok)) await CaptureFailure("main");
            await Step("run.end closes the app, deletes the export dir and releases the lock", async () =>
            {
                await Call("run.end", new { runId = _runId });
                if (pid > 0) Expect(Exited(pid), "ErpDemo.exe was closed");
                Expect(!Directory.Exists(exportDir), "the export dir is gone");
                await ExpectError(-32008, () => Call("snapshot", new { runId = _runId }));
            });
        }
    }

    private async Task V2Smoke()
    {
        _runId = "v2-" + Guid.NewGuid().ToString("N")[..8];
        await Step("v2 build: Search became Find, Export moved to Reports with a confirmation", async () =>
        {
            await Call("run.begin", new { runId = _runId, leaseMs = 60000 });
            try
            {
                await Call("app.launch", new { runId = _runId, app = new { exe = appV2Path } });
                await SignIn("btnFind");
                await ExpectError(-32004, () => Call("resolve", new { runId = _runId, target = TW(MainTitle, new { automationId = "btnSearch" }), timeoutMs = 0 }));
                await Act(TW(MainTitle, new { controlType = "MenuItem", name = "File" }), "click");
                await Call("resolve", new { runId = _runId, target = T(new { controlType = "MenuItem", name = "Exit" }), timeoutMs = 5000 });
                await ExpectError(-32004, () => Call("resolve", new { runId = _runId, target = T(new { controlType = "MenuItem", name = "Export..." }), timeoutMs = 0 }));
                // Close the File menu: Escape is a navigation key, allowed without write: true even with a menu open.
                await Call("act", new { runId = _runId, action = "key", value = "Escape", timeoutMs = 5000 });
                await Call("act", new { runId = _runId, action = "key", value = "Escape", timeoutMs = 5000 });
                await Act(TW(MainTitle, new { controlType = "MenuItem", name = "Reports" }), "click");
                await Act(T(new { controlType = "MenuItem", name = "Export line items..." }), "click", timeoutMs: 5000);
                await Call("resolve", new { runId = _runId, target = TW("Confirm export", new { automationId = "btnConfirmExport" }), timeoutMs = 15000 });
                await SaveSnapshot("snapshot-v2-confirm.json", new { title = "Confirm export" });
            }
            catch
            {
                await CaptureFailure("v2");
                throw;
            }
            finally
            {
                await Call("run.end", new { runId = _runId });
            }
        });
    }

    // The repair agent's exploration on the v2 build: what repair mode may do (expand, Escape without a target, windows,
    // snapshot) and what real WinForms UI Automation shows while a menu drop-down or a dialog is open. Every OBSERVE line
    // records real behaviour (later fakes copy it); assertions are limited to what the protocol promises.
    private async Task V2Repair()
    {
        _runId = "repair-" + Guid.NewGuid().ToString("N")[..8];
        var failedBefore = _results.Count(r => !r.Ok);
        var begun = false;
        List<JsonNode> baseline = [];
        try
        {
            if (!await Step("repair (v2): run.begin, launch the v2 build, sign in", async () =>
                {
                    await Call("run.begin", new { runId = _runId, leaseMs = 120000 });
                    begun = true;
                    await Call("app.launch", new { runId = _runId, app = new { exe = appV2Path } });
                    await SignIn("btnFind");
                    baseline = await WaitWindows("after sign-in (baseline)",
                        l => l.Any(w => Str(w, "title") == MainTitle) && !l.Any(w => Str(w, "title") == LoginTitle));
                    Expect(baseline.Count > 0 && Str(baseline[0], "title") == MainTitle, "the main window is listed first");
                    Expect(baseline[0]["foreground"]!.GetValue<bool>(), "the main window is the foreground window");
                }))
                return;

            var reports = TW(MainTitle, new { controlType = "MenuItem", name = "Reports" });
            JsonNode? dropDown = null;
            await Step("repair a: expand MenuItem \"Reports\" (mode repair) opens a drop-down window that windows lists", async () =>
            {
                await Act(reports, "expand", new { mode = "repair" });
                var list = await WaitWindows("after expand Reports", l => NewWindows(l, baseline).Count > 0);
                var added = NewWindows(list, baseline);
                foreach (var w in added) Observe($"new window after expand Reports: {Describe(w)}");
                dropDown = added.FirstOrDefault(w => Str(w, "className") != "SysShadow") ?? added.FirstOrDefault();
                Expect(dropDown is not null, "a new window of the run is listed while the drop-down is open");
                Observe($"drop-down window: {Describe(dropDown!)}; listed at index {list.IndexOf(dropDown!)} of {list.Count}");
            });

            await Step("repair b: while the drop-down is open, MenuItem \"Export line items...\" shows in a snapshot", async () =>
            {
                var seenIn = new List<string>();
                var none = await SaveSnapshot("snapshot-repair-open-nowindow.json");
                var hasNone = HasNode(none, "MenuItem", "Export line items...");
                Observe($"snapshot without window selector: returned window title=\"{none["window"]!["title"]}\" exe={none["window"]!["exe"]}, root {NodeText(none, 0)}, {Nodes(none).Count} nodes, has MenuItem \"Export line items...\": {hasNone}");
                if (hasNone) seenIn.Add("snapshot without window");
                var main = await SaveSnapshot("snapshot-repair-open-main.json", new { title = MainTitle });
                var hasMain = HasNode(main, "MenuItem", "Export line items...");
                Observe($"snapshot of window {{title: \"{MainTitle}\"}}: {Nodes(main).Count} nodes, has MenuItem \"Export line items...\": {hasMain}{(hasMain ? $" (parent: {ParentText(main, "Export line items...")})" : "")}; Menu nodes: {Nodes(main).Count(n => Str(n, "controlType") == "Menu")}");
                if (hasMain) seenIn.Add("snapshot of the main window");
                if (dropDown is not null)
                {
                    var dd = await SaveSnapshot("snapshot-repair-open-dropdown.json", SelOf(dropDown));
                    var hasDd = HasNode(dd, "MenuItem", "Export line items...");
                    Observe($"snapshot of the drop-down window (selector {SelOf(dropDown).ToJsonString()}): returned title=\"{dd["window"]!["title"]}\", root {NodeText(dd, 0)}, nodes: {Brief(dd, 10)}");
                    if (hasDd) seenIn.Add("snapshot of the drop-down window");
                }
                Observe($"MenuItem \"Export line items...\" visible in: {(seenIn.Count == 0 ? "none" : string.Join(", ", seenIn))}");
                Expect(seenIn.Count > 0, "MenuItem \"Export line items...\" is visible in at least one snapshot");
            });

            await Step("repair c: key Escape (mode repair, no target) closes the drop-down", async () =>
            {
                await RepairEscape();
                var list = await WaitWindows("after one Escape", l => NewWindows(l, baseline).Count == 0);
                Expect(NewWindows(list, baseline).Count == 0, "the drop-down window is gone");
                // Is the menu bar still in menu mode (Reports highlighted)? Then Down reopens a drop-down.
                var reopened = await DownReopens("after one Escape", baseline);
                Observe($"menu mode after one Escape: {(reopened ? "yes (Down reopened a drop-down)" : "no (Down opened nothing)")}");
                if (reopened)
                {
                    await RepairEscape();
                    list = await WaitWindows("after Escape on the reopened drop-down", l => NewWindows(l, baseline).Count == 0);
                    await RepairEscape();
                    var again = await DownReopens("after two more Escapes", baseline);
                    Observe($"menu mode after a second Escape: {(again ? "yes (Down reopened a drop-down)" : "no (Down opened nothing): the second Escape leaves the menu bar")}");
                }
                Observe($"Escapes needed to clean up: {await CloseNewWindows(baseline)}");
            });

            await Step("repair d: expanding Help while the Reports drop-down is open", async () =>
            {
                await Act(reports, "expand", new { mode = "repair" });
                await WaitWindows("after expand Reports (d)", l => NewWindows(l, baseline).Count > 0);
                await Act(TW(MainTitle, new { controlType = "MenuItem", name = "Help" }), "expand", new { mode = "repair" });
                await Task.Delay(500);
                var list = await WaitWindows("after expand Help", _ => true);
                var added = NewWindows(list, baseline);
                var reportsOpen = false;
                var helpOpen = false;
                for (var i = 0; i < added.Count; i++)
                {
                    var snap = await SaveSnapshot($"snapshot-repair-d-window{i}.json", SelOf(added[i]), maxNodes: 60);
                    var r = HasNode(snap, "MenuItem", "Export line items...");
                    var h = HasNode(snap, "MenuItem", "About");
                    reportsOpen |= r;
                    helpOpen |= h;
                    Observe($"new window {i} after expand Help: {Describe(added[i])}; root {NodeText(snap, 0)}; has \"Export line items...\": {r}, has \"About\": {h}");
                }
                var main = await SaveSnapshot("snapshot-repair-d-main.json", new { title = MainTitle });
                Observe($"main window tree after expand Help: has \"Export line items...\": {HasNode(main, "MenuItem", "Export line items...")}, has \"About\": {HasNode(main, "MenuItem", "About")}");
                Observe($"expanding Help while Reports is open: Reports drop-down {(reportsOpen ? "stays open" : "closed")}, Help drop-down {(helpOpen ? "open" : "not seen")}");
                Observe($"Escapes needed to clean up: {await CloseNewWindows(baseline)}");
            });

            await Step("repair e: click on a Button, key Enter, and Escape with a target are policy_refused (-32003)", async () =>
            {
                await ExpectError(-32003, () => Act(TW(MainTitle, new { controlType = "Button", name = "Find" }), "click", new { mode = "repair" }));
                await ExpectError(-32003, () => Call("act", new { runId = _runId, action = "key", value = "Enter", mode = "repair", timeoutMs = 5000 }));
                await ExpectError(-32003, () => Act(TW(MainTitle, new { automationId = "txtDateFrom" }), "key", new { value = "Escape", mode = "repair" }));
            });

            await Step("repair f1: the Confirm export dialog: windows, snapshot, and Escape (mode repair) cancels it", async () =>
            {
                await OpenConfirmExport();
                var list = await WaitWindows("with Confirm export open", l => l.Any(w => Str(w, "title") == "Confirm export"));
                var confirm = list.FirstOrDefault(w => Str(w, "title") == "Confirm export");
                Expect(confirm is not null, "windows lists Confirm export");
                Observe($"Confirm export: index {list.IndexOf(confirm!)} of {list.Count}, {Describe(confirm!)}");
                var snap = await SaveSnapshot("snapshot-repair-confirm-nowindow.json");
                Observe($"snapshot without window selector: title=\"{snap["window"]!["title"]}\", nodes: {Brief(snap, 12)}");
                await RepairEscape();
                list = await WaitWindows("after Escape on Confirm export", l => !l.Any(w => Str(w, "title") == "Confirm export"));
                var gone = !list.Any(w => Str(w, "title") == "Confirm export");
                Observe($"Escape cancels Confirm export: {gone}; first window now: {(list.Count > 0 ? Describe(list[0]) : "none")}");
                Expect(gone, "Escape closed Confirm export");
            });

            await Step("repair f2: Continue opens the Save dialog; Escape (mode repair) cancels it", async () =>
            {
                // A Confirm export left open by f1 would stay behind a second one (the menu still works through UI
                // Automation while the dialog is modal), so start from the main window alone.
                await CloseNewWindows(baseline);
                await OpenConfirmExport();
                await Act(TW("Confirm export", new { controlType = "Button", name = "Continue" }), "click");
                await Call("resolve", new { runId = _runId, target = TW(SaveTitle, new { automationId = "1001", controlType = "Edit" }), timeoutMs = 15000 });
                var list = await WaitWindows("with the Save dialog open", l => l.Any(w => Str(w, "title") == SaveTitle));
                var save = list.FirstOrDefault(w => Str(w, "title") == SaveTitle);
                Expect(save is not null, "windows lists the Save dialog");
                Observe($"Save dialog: index {list.IndexOf(save!)} of {list.Count}, {Describe(save!)}");
                var snap = await SaveSnapshot("snapshot-repair-save-nowindow.json", maxNodes: 1500);
                Observe($"snapshot without window selector: title=\"{snap["window"]!["title"]}\", root {NodeText(snap, 0)}, {Nodes(snap).Count} nodes{(snap["truncated"]?.GetValue<bool>() == true ? " (truncated)" : "")}");
                await RepairEscape();
                list = await WaitWindows("after Escape on the Save dialog", l => !l.Any(w => Str(w, "title") == SaveTitle));
                var gone = !list.Any(w => Str(w, "title") == SaveTitle);
                Observe($"Escape cancels the Save dialog: {gone}; first window now: {(list.Count > 0 ? Describe(list[0]) : "none")}");
                Expect(gone, "Escape closed the Save dialog");
            });
        }
        finally
        {
            if (_results.Count(r => !r.Ok) > failedBefore && begun) await CaptureFailure("repair");
            if (begun)
            {
                try { await Call("run.end", new { runId = _runId }); }
                catch (Exception e) { Console.WriteLine($"    (run.end failed: {e.Message})"); }
            }
        }
    }

    private async Task SignIn(string mainControlId)
    {
        await Call("resolve", new { runId = _runId, target = TW(LoginTitle, new { automationId = "txtUser" }), timeoutMs = 30000 });
        await Act(TW(LoginTitle, new { automationId = "txtUser" }), "type", new { value = "clerk" });
        await Act(TW(LoginTitle, new { automationId = "txtPassword" }), "type", new { value = Password });
        await Act(TW(LoginTitle, new { automationId = "btnSignIn" }), "click");
        await Call("resolve", new { runId = _runId, target = TW(MainTitle, new { automationId = mainControlId }), timeoutMs = 15000 });
    }

    private async Task OpenConfirmExport()
    {
        await Act(TW(MainTitle, new { controlType = "MenuItem", name = "Reports" }), "click");
        await Act(T(new { controlType = "MenuItem", name = "Export line items..." }), "click", timeoutMs: 5000);
        await Call("resolve", new { runId = _runId, target = TW("Confirm export", new { automationId = "btnConfirmExport" }), timeoutMs = 15000 });
    }

    private Task<JsonNode> RepairEscape() =>
        Call("act", new { runId = _runId, action = "key", value = "Escape", mode = "repair", timeoutMs = 5000 });

    /// <summary>Sends Down (step mode, no target) and reports whether a new window (a drop-down) appeared.</summary>
    private async Task<bool> DownReopens(string label, List<JsonNode> baseline)
    {
        try
        {
            await Call("act", new { runId = _runId, action = "key", value = "Down", timeoutMs = 5000 });
        }
        catch (RunnerError e)
        {
            Observe($"key Down (step mode, no target) {label}: refused {e.Code}: {e.RunnerMessage}");
            return false;
        }
        await Task.Delay(500);
        var list = await WaitWindows($"after key Down {label}", _ => true);
        return NewWindows(list, baseline).Count > 0;
    }

    /// <summary>Presses Escape (repair mode) until no window beyond the baseline is listed; returns how many it took.</summary>
    private async Task<int> CloseNewWindows(List<JsonNode> baseline)
    {
        for (var i = 0; i < 4; i++)
        {
            var list = await WaitWindows($"cleanup check {i}", l => NewWindows(l, baseline).Count == 0, ms: 1000, print: false);
            if (NewWindows(list, baseline).Count == 0) return i;
            await RepairEscape();
        }
        throw new InvalidOperationException("expected: four Escapes close every new window");
    }

    /// <summary>Polls windows until the condition holds or the time is up; prints the last list.</summary>
    private async Task<List<JsonNode>> WaitWindows(string label, Func<List<JsonNode>, bool> until, int ms = 3000, bool print = true)
    {
        var sw = Stopwatch.StartNew();
        List<JsonNode> list;
        while (true)
        {
            list = (await Call("windows", new { runId = _runId }))["windows"]!.AsArray().Select(n => n!).ToList();
            if (until(list) || sw.ElapsedMilliseconds >= ms) break;
            await Task.Delay(200);
        }
        if (print)
        {
            Observe($"windows {label}: {list.Count} entries");
            for (var i = 0; i < list.Count; i++) Observe($"  [{i}] {Describe(list[i])}");
        }
        return list;
    }

    private static List<JsonNode> NewWindows(List<JsonNode> list, List<JsonNode> baseline)
    {
        var known = baseline.Select(WindowKey).ToHashSet();
        return list.Where(w => !known.Contains(WindowKey(w))).ToList();
    }

    private static string WindowKey(JsonNode w) => $"{Str(w, "title")}|{Str(w, "automationId")}|{Str(w, "className")}";

    private static string Describe(JsonNode w) =>
        $"title=\"{Str(w, "title")}\" exe={Str(w, "exe")} automationId=\"{Str(w, "automationId")}\" className=\"{Str(w, "className")}\" foreground={w["foreground"]?.GetValue<bool>()}";

    /// <summary>A window selector from what windows reported: the exact title (or an empty one), automation id and class.</summary>
    private static JsonObject SelOf(JsonNode w)
    {
        var o = new JsonObject();
        if (Str(w, "title").Length > 0) o["title"] = Str(w, "title");
        else o["titlePattern"] = "^$";
        if (Str(w, "automationId").Length > 0) o["automationId"] = Str(w, "automationId");
        if (Str(w, "className").Length > 0) o["className"] = Str(w, "className");
        return o;
    }

    private static string Str(JsonNode? n, string key) => n?[key]?.GetValue<string>() ?? "";

    private static List<JsonNode> Nodes(JsonNode snap) => snap["nodes"]!.AsArray().Select(n => n!).ToList();

    private static bool HasNode(JsonNode snap, string controlType, string name) =>
        Nodes(snap).Any(n => Str(n, "controlType") == controlType && Str(n, "name") == name);

    private static string NodeText(JsonNode snap, int index)
    {
        var nodes = Nodes(snap);
        if (index >= nodes.Count) return "(none)";
        var n = nodes[index];
        return $"{Str(n, "controlType")} \"{Str(n, "name")}\" automationId=\"{Str(n, "automationId")}\" className=\"{Str(n, "className")}\"";
    }

    /// <summary>The nearest node above the named one with a smaller depth (its parent in the pruned tree).</summary>
    private static string ParentText(JsonNode snap, string name)
    {
        var nodes = Nodes(snap);
        var i = nodes.FindIndex(n => Str(n, "name") == name);
        var depth = nodes[i]["depth"]!.GetValue<int>();
        for (var j = i - 1; j >= 0; j--)
            if (nodes[j]["depth"]!.GetValue<int>() < depth) return $"{NodeText(snap, j)} at depth {nodes[j]["depth"]}";
        return "(none)";
    }

    private static string Brief(JsonNode snap, int max)
    {
        var nodes = Nodes(snap);
        var parts = nodes.Take(max).Select(n =>
            $"{n["depth"]}:{Str(n, "controlType")} \"{Str(n, "name")}\"{(Str(n, "automationId").Length > 0 ? "#" + Str(n, "automationId") : "")}");
        return string.Join("; ", parts) + (nodes.Count > max ? $"; ... ({nodes.Count} nodes)" : "");
    }

    private static void Observe(string text) => Console.WriteLine($"    OBSERVE: {text}");

    private async Task LeaseExpiry()
    {
        _runId = "lease-" + Guid.NewGuid().ToString("N")[..8];
        await Step("an expired lease ends the run like run.end", async () =>
        {
            var exportDir = (await Call("run.begin", new { runId = _runId, leaseMs = 5000 }))["exportDir"]!.GetValue<string>();
            var pid = (await Call("app.launch", new { runId = _runId, app = new { exe = appPath } }))["pid"]!.GetValue<int>();
            await Task.Delay(TimeSpan.FromSeconds(8));
            Expect(Exited(pid), "the app the run launched was closed");
            Expect(!Directory.Exists(exportDir), "the export dir was deleted");
            await ExpectError(-32008, () => Call("run.heartbeat", new { runId = _runId }));
            var next = "after-" + _runId;
            await Call("run.begin", new { runId = next, leaseMs = 5000 });
            await Call("run.end", new { runId = next });
        });
    }

    private async Task WrongToken()
    {
        await Step("a wrong token gets HTTP 401 and no upgrade", async () =>
        {
            var status = await RpcClient.RefusedStatusAsync(url, "wrong-" + Guid.NewGuid().ToString("N"), fingerprint);
            Expect(status == HttpStatusCode.Unauthorized, $"401 (got {(int)status})");
            var none = await RpcClient.RefusedStatusAsync(url, null, fingerprint);
            Expect(none == HttpStatusCode.Unauthorized, $"401 without a token (got {(int)none})");
        });
    }

    // --- helpers ---

    private static object T(params object[] path) => new { path };

    private static object TW(string title, params object[] path) => new { window = new { title }, path };

    private Task<JsonNode> Call(string method, object? p = null) => _rpc.CallAsync(method, p);

    private Task<JsonNode> Act(object target, string action, object? extra = null, int timeoutMs = 10000)
    {
        var o = JsonSerializer.SerializeToNode(new { runId = _runId, target, action, timeoutMs })!.AsObject();
        if (extra is not null)
            foreach (var kv in JsonSerializer.SerializeToNode(extra)!.AsObject().ToList())
                o[kv.Key] = kv.Value?.DeepClone();
        return Call("act", o);
    }

    private async Task<string> Read(object target) => (await Act(target, "read"))["text"]!.GetValue<string>();

    private async Task<JsonNode> SaveSnapshot(string file, object? window = null, int maxNodes = 400)
    {
        var snap = await Call("snapshot", new { runId = _runId, window, maxNodes });
        File.WriteAllText(Path.Combine(outDir, file), snap.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return snap;
    }

    private async Task CaptureFailure(string label)
    {
        try
        {
            var png = Convert.FromBase64String((await Call("screenshot", new { runId = _runId }))["base64"]!.GetValue<string>());
            File.WriteAllBytes(Path.Combine(outDir, $"failure-{label}.png"), png);
            await SaveSnapshot($"failure-{label}-snapshot.json", null, 1500);
        }
        catch (Exception e)
        {
            Console.WriteLine($"    (could not capture the failure state: {e.Message})");
        }
    }

    private static bool Exited(int pid)
    {
        for (var i = 0; i < 50; i++)
        {
            try
            {
                using var p = Process.GetProcessById(pid);
                if (p.HasExited) return true;
            }
            catch (ArgumentException)
            {
                return true;
            }
            Thread.Sleep(100);
        }
        return false;
    }

    private static void Expect(bool condition, string what)
    {
        if (!condition) throw new InvalidOperationException($"expected: {what}");
    }

    private static async Task<RunnerError> ExpectError(int code, Func<Task> call)
    {
        try
        {
            await call();
        }
        catch (RunnerError e)
        {
            if (e.Code != code) throw new InvalidOperationException($"expected error {code}, got {e.Code}: {e.RunnerMessage}");
            Console.WriteLine($"    got {code}: {e.RunnerMessage}");
            return e;
        }
        throw new InvalidOperationException($"expected error {code}, but the call succeeded");
    }

    private async Task<bool> Step(string name, Func<Task> body)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await body();
            _results.Add((name, true, null));
            Console.WriteLine($"PASS {name} ({sw.ElapsedMilliseconds} ms)");
            return true;
        }
        catch (Exception e)
        {
            _results.Add((name, false, e.Message));
            Console.WriteLine($"FAIL {name} ({sw.ElapsedMilliseconds} ms): {e.Message}");
            Console.WriteLine($"::error title=desktop scenario::{name}: {e.Message}");
            return false;
        }
    }
}
