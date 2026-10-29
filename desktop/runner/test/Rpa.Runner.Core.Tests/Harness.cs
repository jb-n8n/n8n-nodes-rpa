using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Time.Testing;
using Rpa.Runner.Core.Policy;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;

namespace Rpa.Runner.Core.Tests;

/// <summary>A runner service over the fake desktop, driven through the JSON-RPC dispatcher like a real client.</summary>
public sealed class Harness : IDisposable
{
    public const string RunId = "run-1";

    public Harness(string? policyJson = null, bool realTime = true)
    {
        Root = Directory.CreateTempSubdirectory("rpa-runner-test-").FullName;
        AppPath = Path.Combine(Root, "apps", "ErpDemo.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(AppPath)!);
        File.WriteAllText(AppPath, "fake");
        Policy = RunnerPolicy.Parse(policyJson ?? $$"""
            {
              "allowedApps": [{ "exe": "ErpDemo.exe", "path": {{JsonSerializer.Serialize(AppPath)}}, "allowedArgs": [["--ui", "v2"]] }],
              "writeControls": [{ "exe": "ErpDemo.exe", "automationId": "btnPost" }],
              "gatedKeys": ["Ctrl+S", "F11"],
              "maxFileBytes": 1024
            }
            """);
        Time = realTime ? null : new FakeTimeProvider(DateTimeOffset.Parse("2026-10-29T10:00:00Z"));
        TimeProvider time = Time is null ? TimeProvider.System : Time;
        Runs = new RunManager(Path.Combine(Root, "exports"), Processes, time, Log, Paths);
        Service = new RunnerService(Desktop, Processes, Policy, Runs, time, Log, "0.1.0-test", Paths);
        Dispatcher = new RpcDispatcher(Service, Log);
    }

    public string Root { get; }
    public string AppPath { get; }
    public RunnerPolicy Policy { get; }
    public FakeTimeProvider? Time { get; }
    public FakeDesktop Desktop { get; } = new();
    public FakeProcessHost Processes { get; } = new();
    public FakePathSecurity Paths { get; } = new();
    public RunnerLog Log { get; } = RunnerLog.Silent;
    public RunManager Runs { get; }
    public RunnerService Service { get; }
    public RpcDispatcher Dispatcher { get; }
    public string? ExportDir { get; private set; }
    private int _id;

    /// <summary>Sends a request; returns the whole response object.</summary>
    public JsonObject Send(string method, object? @params = null)
    {
        var req = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = ++_id, ["method"] = method };
        if (@params is not null) req["params"] = JsonSerializer.SerializeToNode(@params);
        var text = Dispatcher.HandleAsync(req.ToJsonString(), CancellationToken.None).GetAwaiter().GetResult();
        var resp = JsonNode.Parse(text!)!.AsObject();
        Assert.Equal(_id, resp["id"]!.GetValue<int>());
        return resp;
    }

    public JsonNode Ok(string method, object? @params = null)
    {
        var r = Send(method, @params);
        Assert.True(r["error"] is null, $"{method} failed: {r["error"]?.ToJsonString()}");
        return r["result"]!;
    }

    public JsonObject Err(string method, object? @params, int code)
    {
        var r = Send(method, @params);
        Assert.True(r["error"] is not null, $"{method} unexpectedly succeeded: {r["result"]?.ToJsonString()}");
        var e = r["error"]!.AsObject();
        Assert.Equal(code, e["code"]!.GetValue<int>());
        return e;
    }

    public void Begin(long leaseMs = 30000)
    {
        ExportDir = Ok("run.begin", new { runId = RunId, leaseMs })["exportDir"]!.GetValue<string>();
    }

    /// <summary>Begins a run, launches the app and shows its main window (in front, focused).</summary>
    public FakeNode BeginWithApp()
    {
        Begin();
        var pid = Ok("app.launch", new { runId = RunId, app = new { exe = "ErpDemo.exe" } })["pid"]!.GetValue<int>();
        var w = MainWindow(pid);
        Desktop.Windows.Insert(0, w);
        Desktop.Foreground = w;
        return w;
    }

    public static FakeNode MainWindow(int pid)
    {
        var w = new FakeNode("Window", "ERP Demo - Line items", "MainForm", pid);
        w.Child("Edit", "User name", "txtUser", n => n.Value = "clerk")
         .Child("Edit", "Password", "txtPassword", n => { n.IsPassword = true; n.Value = "should-never-leave"; })
         .Child("Button", "Sign in", "btnSignIn")
         .Child("Button", "Post", "btnPost")
         .Child("Edit", "API key", "txtApiKey", n => n.Value = "also-hidden");
        var list = new FakeNode("List", "Results", "lstResults");
        list.Child("ListItem", "Row A", "").Child("ListItem", "Row B", "");
        w.Add(list);
        var pane = new FakeNode("Pane");
        pane.Child("Button", "Inner", "btnInner");
        w.Add(pane);
        var post = (FakeNode)w.GetChildren().Single(c => c.AutomationId == "btnPost");
        post.Child("Text", "Post", "lblPostCaption");
        return w;
    }

    public static object T(params object[] path) => new { path };

    public void Dispose()
    {
        Runs.Dispose();
        try { Directory.Delete(Root, true); }
        catch (IOException) { }
    }
}
