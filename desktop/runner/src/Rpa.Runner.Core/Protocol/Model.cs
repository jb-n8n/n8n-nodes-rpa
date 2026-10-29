using System.Text.Json;
using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Protocol;

/// <summary>Selects top-level windows; every given field must match. <c>Exe</c> is a file name, case-insensitive.</summary>
public sealed record WindowSel(string? Exe, string? Title, string? TitlePattern, string? AutomationId, string? ClassName)
{
    public override string ToString() => Describe.Fields(("exe", Exe), ("title", Title), ("titlePattern", TitlePattern),
        ("automationId", AutomationId), ("className", ClassName));
}

/// <summary>UI Automation properties to match; <c>Index</c> picks among siblings that match the rest (0-based).</summary>
public sealed record Cond(string? ControlType, string? AutomationId, string? Name, string? ClassName, int? Index)
{
    public override string ToString() => Describe.Fields(("controlType", ControlType), ("automationId", AutomationId),
        ("name", Name), ("className", ClassName), ("index", Index?.ToString(System.Globalization.CultureInfo.InvariantCulture)));
}

/// <summary>A path of conditions matched as descendants in order, with optional fallbacks.</summary>
public sealed record Target(WindowSel? Window, IReadOnlyList<Cond> Path, IReadOnlyList<Target> Fallbacks)
{
    /// <summary>A description for error messages: the window selector and the path, never a typed value.</summary>
    public string Describe()
    {
        var path = string.Join(" > ", Path.Select(c => c.ToString()));
        return Window is null ? path : $"{Window} :: {path}";
    }
}

public enum ActionKind { Click, DoubleClick, Type, Select, Check, Uncheck, Key, Read, Expand, Focus }

public enum ActMode { Step, Repair }

/// <summary>A piece of a <c>type</c> value: literal text, or the run's export directory.</summary>
public sealed record Segment(string? Text, bool ExportDir);

public sealed record AppSpec(string Exe, IReadOnlyList<string> Args);

internal static class Describe
{
    public static string Fields(params (string Key, string? Value)[] fields)
    {
        var parts = fields.Where(f => f.Value is not null).Select(f => $"{f.Key}={Quote(f.Value!)}");
        return "{" + string.Join(", ", parts) + "}";
    }

    private static string Quote(string s) => "\"" + (s.Length > 80 ? s[..80] + "..." : s) + "\"";
}

/// <summary>Reads and validates request params. Every failure is -32602 with the offending field named.</summary>
public sealed class Params
{
    private readonly JsonElement _root;

    public Params(JsonElement? root)
    {
        if (root is { ValueKind: JsonValueKind.Object } r) _root = r;
        else if (root is null || root.Value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            _root = JsonDocument.Parse("{}").RootElement;
        else throw RpcErrors.InvalidParamsError("params must be an object");
    }

    public JsonElement Root => _root;

    public bool Has(string name) => _root.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null;

    public string? OptString(string name) => ReadString(_root, name, required: false);

    public string ReqString(string name) => ReadString(_root, name, required: true)!;

    public bool? OptBool(string name)
    {
        if (!_root.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw RpcErrors.InvalidParamsError($"{name} must be a boolean"),
        };
    }

    public long? OptLong(string name, long min, long max)
    {
        if (!_root.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n))
            throw RpcErrors.InvalidParamsError($"{name} must be an integer");
        if (n < min || n > max) throw RpcErrors.InvalidParamsError($"{name} must be between {min} and {max}");
        return n;
    }

    public long ReqLong(string name, long min, long max) =>
        OptLong(name, min, max) ?? throw RpcErrors.InvalidParamsError($"{name} is required");

    public Target ReqTarget(string name)
    {
        if (!_root.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null)
            throw RpcErrors.InvalidParamsError($"{name} is required");
        return ParseTarget(v, name, depth: 0);
    }

    public Target? OptTarget(string name) => Has(name) ? ReqTarget(name) : null;

    public WindowSel? OptWindow(string name) =>
        _root.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? ParseWindow(v, name) : null;

    public ActionKind ReqAction(string name)
    {
        var s = ReqString(name);
        return s switch
        {
            "click" => ActionKind.Click,
            "doubleClick" => ActionKind.DoubleClick,
            "type" => ActionKind.Type,
            "select" => ActionKind.Select,
            "check" => ActionKind.Check,
            "uncheck" => ActionKind.Uncheck,
            "key" => ActionKind.Key,
            "read" => ActionKind.Read,
            "expand" => ActionKind.Expand,
            "focus" => ActionKind.Focus,
            _ => throw RpcErrors.InvalidParamsError($"{name} is not a known action"),
        };
    }

    public ActMode OptMode(string name) => OptString(name) switch
    {
        null or "step" => ActMode.Step,
        "repair" => ActMode.Repair,
        _ => throw RpcErrors.InvalidParamsError($"{name} must be 'step' or 'repair'"),
    };

    public IReadOnlyList<Segment>? OptSegments(string name)
    {
        if (!_root.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        if (v.ValueKind != JsonValueKind.Array) throw RpcErrors.InvalidParamsError($"{name} must be an array");
        var list = new List<Segment>();
        var i = 0;
        foreach (var s in v.EnumerateArray())
        {
            var where = $"{name}[{i++}]";
            if (s.ValueKind != JsonValueKind.Object) throw RpcErrors.InvalidParamsError($"{where} must be an object");
            var props = s.EnumerateObject().Select(p => p.Name).ToList();
            if (props.Count != 1) throw RpcErrors.InvalidParamsError($"{where} must have exactly one of text or exportDir");
            if (s.TryGetProperty("text", out var t))
            {
                if (t.ValueKind != JsonValueKind.String) throw RpcErrors.InvalidParamsError($"{where}.text must be a string");
                list.Add(new Segment(t.GetString(), false));
            }
            else if (s.TryGetProperty("exportDir", out var e))
            {
                if (e.ValueKind != JsonValueKind.True) throw RpcErrors.InvalidParamsError($"{where}.exportDir must be true");
                list.Add(new Segment(null, true));
            }
            else throw RpcErrors.InvalidParamsError($"{where} must have exactly one of text or exportDir");
        }
        return list;
    }

    public AppSpec ReqApp(string name)
    {
        if (!_root.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Object)
            throw RpcErrors.InvalidParamsError($"{name} must be an object");
        var exe = ReadString(v, "exe", required: true, prefix: name + ".")!;
        if (exe.Length == 0) throw RpcErrors.InvalidParamsError($"{name}.exe must not be empty");
        var args = new List<string>();
        if (v.TryGetProperty("args", out var a) && a.ValueKind != JsonValueKind.Null)
        {
            if (a.ValueKind != JsonValueKind.Array) throw RpcErrors.InvalidParamsError($"{name}.args must be an array of strings");
            foreach (var x in a.EnumerateArray())
            {
                if (x.ValueKind != JsonValueKind.String) throw RpcErrors.InvalidParamsError($"{name}.args must be an array of strings");
                args.Add(x.GetString()!);
            }
        }
        return new AppSpec(exe, args);
    }

    private static string? ReadString(JsonElement obj, string name, bool required, string prefix = "")
    {
        if (!obj.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null)
        {
            if (required) throw RpcErrors.InvalidParamsError($"{prefix}{name} is required");
            return null;
        }
        if (v.ValueKind != JsonValueKind.String) throw RpcErrors.InvalidParamsError($"{prefix}{name} must be a string");
        return v.GetString();
    }

    private const int MaxFallbacks = 10;
    private const int MaxPath = 20;

    internal static Target ParseTarget(JsonElement v, string where, int depth)
    {
        if (v.ValueKind != JsonValueKind.Object) throw RpcErrors.InvalidParamsError($"{where} must be an object");
        WindowSel? window = null;
        if (v.TryGetProperty("window", out var w) && w.ValueKind != JsonValueKind.Null) window = ParseWindow(w, where + ".window");
        if (!v.TryGetProperty("path", out var p) || p.ValueKind != JsonValueKind.Array)
            throw RpcErrors.InvalidParamsError($"{where}.path must be an array");
        var path = new List<Cond>();
        var i = 0;
        foreach (var c in p.EnumerateArray()) path.Add(ParseCond(c, $"{where}.path[{i++}]"));
        if (path.Count == 0) throw RpcErrors.InvalidParamsError($"{where}.path must not be empty");
        if (path.Count > MaxPath) throw RpcErrors.InvalidParamsError($"{where}.path has more than {MaxPath} entries");
        var fallbacks = new List<Target>();
        if (v.TryGetProperty("fallbacks", out var f) && f.ValueKind != JsonValueKind.Null)
        {
            if (depth > 0) throw RpcErrors.InvalidParamsError($"{where}.fallbacks: fallbacks cannot be nested");
            if (f.ValueKind != JsonValueKind.Array) throw RpcErrors.InvalidParamsError($"{where}.fallbacks must be an array");
            var j = 0;
            foreach (var t in f.EnumerateArray()) fallbacks.Add(ParseTarget(t, $"{where}.fallbacks[{j++}]", depth + 1));
            if (fallbacks.Count > MaxFallbacks) throw RpcErrors.InvalidParamsError($"{where}.fallbacks has more than {MaxFallbacks} entries");
        }
        return new Target(window, path, fallbacks);
    }

    internal static WindowSel ParseWindow(JsonElement v, string where)
    {
        if (v.ValueKind != JsonValueKind.Object) throw RpcErrors.InvalidParamsError($"{where} must be an object");
        var sel = new WindowSel(
            ReadString(v, "exe", false, where + "."),
            ReadString(v, "title", false, where + "."),
            ReadString(v, "titlePattern", false, where + "."),
            ReadString(v, "automationId", false, where + "."),
            ReadString(v, "className", false, where + "."));
        if (sel.TitlePattern is not null)
        {
            try { _ = new Regex(sel.TitlePattern, RegexOptions.None, TimeSpan.FromMilliseconds(100)); }
            catch (ArgumentException) { throw RpcErrors.InvalidParamsError($"{where}.titlePattern is not a valid regular expression"); }
        }
        return sel;
    }

    internal static Cond ParseCond(JsonElement v, string where)
    {
        if (v.ValueKind != JsonValueKind.Object) throw RpcErrors.InvalidParamsError($"{where} must be an object");
        int? index = null;
        if (v.TryGetProperty("index", out var ix) && ix.ValueKind != JsonValueKind.Null)
        {
            if (ix.ValueKind != JsonValueKind.Number || !ix.TryGetInt32(out var n) || n < 0)
                throw RpcErrors.InvalidParamsError($"{where}.index must be a non-negative integer");
            index = n;
        }
        var cond = new Cond(
            ReadString(v, "controlType", false, where + "."),
            ReadString(v, "automationId", false, where + "."),
            ReadString(v, "name", false, where + "."),
            ReadString(v, "className", false, where + "."),
            index);
        if (cond.ControlType is null && cond.AutomationId is null && cond.Name is null && cond.ClassName is null)
            throw RpcErrors.InvalidParamsError($"{where} needs at least one of controlType, automationId, name, className");
        return cond;
    }
}
