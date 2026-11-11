using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;

namespace Rpa.Recorder.Core.Tests;

/// <summary>Elements, windows and observations as the Windows layer would report them.</summary>
internal static class Fakes
{
    public const string WinFormsClass = "WindowsForms10.Window.8.app.0.19fd5c7_r3_ad1";
    public static readonly DateTimeOffset T0 = new(2026, 11, 10, 22, 0, 0, TimeSpan.Zero);

    /// <summary>An element; its runtime id is made from its type, id and name, so the same facts are the same element.</summary>
    public static ElementFacts El(string type, string id = "", string name = "", string cls = "", bool password = false,
        bool editChild = false, params ElementFacts[] ancestors) =>
        new(type, id, name, cls, password, editChild, $"{type}|{id}|{name}", ancestors);

    public static readonly WindowFacts Window = new("app.exe", "App", "AppMainWindow");

    public static DateTimeOffset At(int second) => T0.AddSeconds(second);

    public static MouseDown Click(int second, ElementFacts element, int matches = 1, WindowFacts? window = null) =>
        new(At(second), window ?? Window, element, matches);

    public static KeyDown Typed(int second, ElementFacts focused, WindowFacts? window = null) =>
        new(At(second), window ?? Window, focused, "", true);

    public static KeyDown Key(int second, ElementFacts focused, string chord, WindowFacts? window = null) =>
        new(At(second), window ?? Window, focused, chord, false);

    public static FieldLeft Left(int second, ElementFacts field, string? value, string? selection = null, WindowFacts? window = null) =>
        new(At(second), window ?? Window, field, value, selection);

    public static Session Record(params Observation[] observations)
    {
        var session = new Session();
        foreach (var o in observations) session.Add(o);
        return session;
    }

    /// <summary>A value made at run time, standing in for a typed password.</summary>
    public static string NewSecret() => "s" + Convert.ToHexString(RandomNumberGenerator.GetBytes(12));

    /// <summary>Every string the object holds, through its fields, records and lists (the recorder's own types only).</summary>
    public static List<string> StringsIn(object root)
    {
        var found = new List<string>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var assembly = typeof(Session).Assembly;
        void Walk(object? o)
        {
            if (o is null || o.GetType().IsPrimitive || o is DateTimeOffset || o is Enum) return;
            if (o is string s) { found.Add(s); return; }
            if (!seen.Add(o)) return;
            if (o is IEnumerable items) { foreach (var item in items) Walk(item); return; }
            for (var t = o.GetType(); t is not null && t.Assembly == assembly; t = t.BaseType)
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                    Walk(f.GetValue(o));
        }
        Walk(root);
        return found;
    }

    /// <summary>A file of the repository, read in place.</summary>
    public static string RepoFile(params string[] parts)
    {
        var root = typeof(Fakes).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().Single(a => a.Key == "RepoRoot").Value!;
        return File.ReadAllText(Path.Combine([root, .. parts]));
    }

    public static DateTimeOffset Parse(string time) =>
        DateTimeOffset.Parse($"2026-11-10T{time}+00:00", CultureInfo.InvariantCulture, DateTimeStyles.None);
}
