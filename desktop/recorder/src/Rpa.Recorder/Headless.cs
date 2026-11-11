using System.Globalization;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// <c>RpaRecorder.exe --headless --app &lt;exe&gt; --out &lt;folder&gt; --name &lt;name&gt; [--args ...]</c>, for the scenario
/// test: starts the program, records without the bar until standard input closes, and saves the two files into the
/// folder (an existing file is not replaced). Standard output says <c>ready &lt;process id&gt;</c> once it records and
/// <c>saved &lt;number of steps&gt;</c> at the end; standard error gets each notice as its kind and time only. No log
/// file is written.
/// </summary>
internal static class Headless
{
    public static int Run(string[] args)
    {
        HeadlessOptions options;
        try { options = HeadlessOptions.Parse(args); }
        catch (ArgumentException e) { Console.Error.WriteLine(e.Message); return 2; }

        using var capture = new Capture(readKey: false);
        capture.Noticed += n => Console.Error.WriteLine($"notice {n.Kind} {n.At.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture)}");
        var app = Path.GetFullPath(options.App);
        try
        {
            if (!capture.Launch(app, options.Args))
            {
                Console.Error.WriteLine("the program did not start");
                return 1;
            }
        }
        catch (ArgumentException e) { Console.Error.WriteLine(e.Message); return 2; }
        Console.WriteLine($"ready {capture.AppProcessId}");
        Console.Out.Flush();
        Console.In.ReadToEnd();
        capture.Stop();
        try
        {
            Directory.CreateDirectory(options.Out);
            capture.Save(options.Out, options.Name, overwrite: false);
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"not saved: {e.Message}");
            return 1;
        }
        Console.WriteLine($"saved {capture.Steps().Count}");
        return 0;
    }
}
