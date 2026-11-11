using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// RpaRecorder.exe: watches a person work in a Windows application and saves what they did as a recording file that
/// n8n's Import Steps reads (source RPA Recording), plus a policy change file an administrator applies with
/// <c>RpaPolicy.exe apply</c>. It only watches: it sends no input, starts nothing but the program the person chose, and
/// changes no policy. Without arguments it shows its bar; <c>--headless</c> is for the scenario test (see Headless).
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // Per-monitor DPI awareness, in both modes: the hooks' points and UI Automation's are then the same pixels.
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        if (HeadlessOptions.IsHeadless(args)) return Headless.Run(args);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new RecorderBar());
        return 0;
    }
}
