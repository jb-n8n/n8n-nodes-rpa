using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Rpa.Recorder.Scenario;

/// <summary>
/// The recorder end to end on a real desktop: starts RpaRecorder.exe headless on ERP Demo, performs the reference flow
/// with synthetic input, closes the recorder and checks what it saved.
/// <code>Rpa.Recorder.Scenario --recorder &lt;RpaRecorder.exe&gt; --app &lt;ErpDemo.exe&gt; --golden &lt;erp.rpa-recording.json&gt; --out &lt;folder&gt;</code>
/// Pass 1 (v1) must equal the golden recording apart from timestamps; pass 2 (<c>--ui v2</c>) must be a valid recording
/// with the v2 controls. In neither may the demo password occur in a file the recorder wrote or in what it printed.
/// Exit code 0 when every check passed.
/// </summary>
internal static class Program
{
    private const string Name = "ERP Demo line items";
    // ERP Demo's public sample password (desktop/erp-demo/Program.cs): the recorder treats it as a secret all the same.
    private const string Password = "demo1234";
    private static readonly List<(string Check, bool Ok)> Results = [];

    [STAThread]
    private static int Main(string[] args)
    {
        var options = new Dictionary<string, string>();
        for (var i = 0; i + 1 < args.Length; i += 2) options[args[i]] = args[i + 1];
        string Option(string key) => options.TryGetValue(key, out var v) ? v : throw new ArgumentException($"missing {key}");
        var recorder = Path.GetFullPath(Option("--recorder"));
        var app = Path.GetFullPath(Option("--app"));
        var golden = JsonNode.Parse(File.ReadAllText(Option("--golden")))!;
        var output = Path.GetFullPath(Option("--out"));

        var v1 = Record(recorder, app, [], Path.Combine(output, "v1"), v2: false, seed: 71);
        if (v1 is { } first)
        {
            Check("v1: the recording equals the golden recording apart from timestamps", JsonNode.DeepEquals(WithoutTimes(first.Recording), WithoutTimes(golden)),
                () => first.Recording.ToJsonString(new() { WriteIndented = true }));
            CheckPolicyChange("v1", first.PolicyChange, app, []);
        }
        var v2 = Record(recorder, app, ["--ui", "v2"], Path.Combine(output, "v2"), v2: true, seed: 72);
        if (v2 is { } second)
        {
            CheckV2(second.Recording);
            CheckPolicyChange("v2", second.PolicyChange, app, ["--ui", "v2"]);
        }

        Console.WriteLine();
        Console.WriteLine($"{Results.Count(r => r.Ok)} passed, {Results.Count(r => !r.Ok)} failed");
        return Results.Count > 0 && Results.All(r => r.Ok) ? 0 : 1;
    }

    /// <summary>One pass: the recorder records the flow; null when the pass could not finish.</summary>
    private static (JsonNode Recording, JsonNode PolicyChange)? Record(string recorder, string app, string[] appArgs, string folder, bool v2, int seed)
    {
        var pass = v2 ? "v2" : "v1";
        if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        var saved = Path.Combine(folder, "saved");
        var start = new ProcessStartInfo(recorder)
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var a in new[] { "--headless", "--app", app, "--out", saved, "--name", Name }) start.ArgumentList.Add(a);
        if (appArgs.Length > 0) { start.ArgumentList.Add("--args"); foreach (var a in appArgs) start.ArgumentList.Add(a); }
        using var process = Process.Start(start)!;
        var errors = new StringBuilder();
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (errors) errors.AppendLine(e.Data); };
        process.BeginErrorReadLine();
        var ready = process.StandardOutput.ReadLineAsync();
        int appProcess = 0;
        var started = ready.Wait(TimeSpan.FromSeconds(60)) && ready.Result is { } line && line.StartsWith("ready ", StringComparison.Ordinal) && int.TryParse(line[6..], out appProcess);
        if (!Check($"{pass}: the recorder starts ERP Demo and records", started, () => errors.ToString()))
        {
            if (!process.HasExited) process.Kill();
            return null;
        }
        try
        {
            using var person = new Person(appProcess, seed);
            var flowed = Try(() => person.ErpFlow(Password, v2, Path.Combine(folder, "export", "line-items.csv")), out var failure);
            Check($"{pass}: the person performs the flow", flowed, () => failure);
            process.StandardInput.Close();
            var ended = process.WaitForExit(60000);
            // End ERP Demo before reading the rest of the recorder's output: a program that held the recorder's standard
            // output (as one started with it would) keeps it from ever reaching its end. By its process id.
            try { Process.GetProcessById(appProcess).Kill(); } catch (ArgumentException) { } catch (InvalidOperationException) { }
            var printed = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            Check($"{pass}: the recorder saves and ends when its input closes", ended && process.ExitCode == 0 && printed.StartsWith("saved ", StringComparison.Ordinal),
                () => $"exit {(ended ? process.ExitCode : -1)}; {printed}{errors}");
            Check($"{pass}: the demo password is in no file the recorder wrote and nothing it printed", NoPassword(folder, printed + errors), () => "");
            var recording = Path.Combine(saved, $"{Name}.rpa-recording.json");
            var change = Path.Combine(saved, $"{Name}.policy-change.json");
            if (!Check($"{pass}: the recording file and the policy change file are there", File.Exists(recording) && File.Exists(change), () => string.Join(", ", Directory.Exists(saved) ? Directory.GetFiles(saved) : []))) return null;
            return (JsonNode.Parse(File.ReadAllText(recording))!, JsonNode.Parse(File.ReadAllText(change))!);
        }
        finally
        {
            if (!process.HasExited) process.Kill();
            // The ERP Demo the recorder started, by its own process id.
            try { Process.GetProcessById(appProcess).Kill(); } catch (ArgumentException) { } catch (InvalidOperationException) { }
        }
    }

    private static void CheckV2(JsonNode recording)
    {
        var events = recording["events"]!.AsArray().Select(e => e!).ToList();
        string? Id(JsonNode e) => e["target"]?["path"]?.AsArray().Last()?["automationId"]?.GetValue<string>();
        string? NameOf(JsonNode e) => e["target"]?["path"]?.AsArray().Last()?["name"]?.GetValue<string>();
        string Kind(JsonNode e) => e["kind"]!.GetValue<string>();
        Check("v2: the app and its launch carry --ui v2",
            recording["app"]?["args"]?.ToJsonString() == "[\"--ui\",\"v2\"]" && events.Any(e => Kind(e) == "launch" && e["args"]?.ToJsonString() == "[\"--ui\",\"v2\"]"), () => recording["app"]!.ToJsonString());
        Check("v2: the password is a secret run variable", events.Any(e => Kind(e) == "fill" && Id(e) == "txtPassword" && e["value"]!.GetValue<string>() == "{{var.password}}" && e["secret"]?.GetValue<bool>() == true)
            && recording["secretVariables"]!.ToJsonString() == "[\"password\"]", () => "");
        Check("v2: the user name, company code and dates are there", events.Any(e => Kind(e) == "fill" && Id(e) == "txtUser" && e["value"]!.GetValue<string>() == "clerk")
            && events.Any(e => Kind(e) == "select" && Id(e) == "cmbCompany" && e["option"]!.GetValue<string>() == "2000")
            && events.Any(e => Kind(e) == "fill" && Id(e) == "txtDateFrom" && e["value"]!.GetValue<string>() == "2026-01-20")
            && events.Any(e => Kind(e) == "fill" && Id(e) == "txtDateTo" && e["value"]!.GetValue<string>() == "2026-11-30"), () => "");
        Check("v2: Find, Reports, Export line items... and the confirmation are clicked", events.Any(e => Kind(e) == "click" && Id(e) == "btnFind")
            && events.Any(e => Kind(e) == "click" && NameOf(e) == "Reports") && events.Any(e => Kind(e) == "click" && NameOf(e) == "Export line items...")
            && events.Any(e => Kind(e) == "click" && Id(e) == "btnConfirmExport"), () => string.Join(", ", events.Select(e => $"{Kind(e)} {e["label"]}")));
        Check("v2: the file name goes into the run's export folder, then Save", events.Any(e => Kind(e) == "fill" && e["exportFile"]?.GetValue<string>() == "line-items.csv"
            && e["value"]!.GetValue<string>() == "{{$exportDir}}\\line-items.csv") && Kind(events[^1]) == "click" && Id(events[^1]) == "1", () => "");
        Check("v2: no locator has an index", !recording.ToJsonString().Contains("\"index\"", StringComparison.Ordinal), () => "");
    }

    private static void CheckPolicyChange(string pass, JsonNode change, string app, string[] args)
    {
        var apps = change["allowedApps"]?.AsArray();
        var entry = apps is { Count: 1 } ? apps[0] : null;
        string sha;
        using (var file = File.OpenRead(app)) sha = Convert.ToHexString(SHA256.HashData(file));
        var expectedArgs = args.Length == 0 ? null : new JsonArray(new JsonArray(args.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray())).ToJsonString();
        Check($"{pass}: the policy change allows ErpDemo.exe by its path and SHA-256, and nothing else",
            change.AsObject().Count == 1 && entry is not null && entry["exe"]?.GetValue<string>() == "ErpDemo.exe" && entry["path"]?.GetValue<string>() == app
            && entry["sha256"]?.GetValue<string>() == sha && entry["allowedArgs"]?.ToJsonString() == expectedArgs, () => change.ToJsonString());
    }

    /// <summary>The recording without its timestamps (the "at" of every event).</summary>
    private static JsonNode WithoutTimes(JsonNode recording)
    {
        var copy = recording.DeepClone();
        foreach (var e in copy["events"]!.AsArray()) e!.AsObject().Remove("at");
        return copy;
    }

    private static bool NoPassword(string folder, string printed)
    {
        var utf8 = Encoding.UTF8.GetBytes(Password);
        var utf16 = Encoding.Unicode.GetBytes(Password);
        foreach (var file in Directory.GetFiles(folder, "*", SearchOption.AllDirectories))
        {
            var bytes = File.ReadAllBytes(file);
            if (bytes.AsSpan().IndexOf(utf8) >= 0 || bytes.AsSpan().IndexOf(utf16) >= 0) return false;
        }
        return !printed.Contains(Password, StringComparison.Ordinal);
    }

    private static bool Try(Action action, out string failure)
    {
        try { action(); failure = ""; return true; }
        catch (Exception e) when (e is TimeoutException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            failure = $"{e.GetType().Name}: {e.Message}";
            return false;
        }
    }

    /// <summary>Records a check. <paramref name="detail"/> is printed when it fails; it never holds the password, which
    /// is checked before any recording is printed.</summary>
    private static bool Check(string check, bool ok, Func<string> detail)
    {
        Results.Add((check, ok));
        Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {check}");
        if (!ok)
        {
            var text = detail();
            if (text.Length > 0) Console.WriteLine(text.Contains(Password, StringComparison.Ordinal) ? "    (detail not shown: it holds the demo password)" : "    " + text.Replace("\n", "\n    "));
        }
        return ok;
    }
}
