namespace Rpa.Recorder.Core;

/// <summary>
/// <c>RpaRecorder.exe --headless --app &lt;exe&gt; --out &lt;folder&gt; --name &lt;name&gt; [--args &lt;argument&gt; ...]</c>:
/// records without the bar until standard input closes (for the scenario test). <c>--args</c> comes last: every word
/// after it is an argument of the application.
/// </summary>
public sealed record HeadlessOptions(string App, IReadOnlyList<string> Args, string Out, string Name)
{
    public const string Usage = "usage: RpaRecorder.exe --headless --app <exe> --out <folder> --name <name> [--args <argument> ...]";

    public static bool IsHeadless(IReadOnlyList<string> args) => args.Count > 0 && args[0] == "--headless";

    public static HeadlessOptions Parse(IReadOnlyList<string> args)
    {
        if (!IsHeadless(args)) throw new ArgumentException(Usage);
        var values = new Dictionary<string, string>();
        var appArgs = new List<string>();
        for (var i = 1; i < args.Count; i++)
        {
            if (args[i] == "--args") { appArgs.AddRange(args.Skip(i + 1)); break; }
            if (args[i] is not ("--app" or "--out" or "--name") || i + 1 >= args.Count || !values.TryAdd(args[i], args[i + 1]))
                throw new ArgumentException(Usage);
            i++;
        }
        return values.TryGetValue("--app", out var app) && values.TryGetValue("--out", out var output) && values.TryGetValue("--name", out var name)
            ? new HeadlessOptions(app, appArgs, output, name)
            : throw new ArgumentException(Usage);
    }
}
