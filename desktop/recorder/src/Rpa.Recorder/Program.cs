using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// RpaRecorder.exe: watches a person work in a Windows application and saves what they did as a recording file that
/// n8n's Import Steps reads (source RPA Recording), plus a policy change file an administrator applies with
/// <c>RpaPolicy.exe apply</c>. It only watches: it sends no input, changes no policy, and starts only the program the
/// person chose and, when the person asks after saving, the install's policy tool (which asks for administrator rights
/// and asks again before it changes anything). Without arguments it shows its bar; <c>--headless</c> records without
/// it, only in the scenario test's build (see Headless and the project file): this program refuses it.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // Per-monitor DPI awareness, in both modes: the hooks' points and UI Automation's are then the same pixels.
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        if (HeadlessOptions.IsHeadless(args))
        {
#if RECORDER_SCENARIO
            return Headless.Run(args);
#else
            const string refused = "This RPA Recorder records only with its bar on screen: start RpaRecorder.exe without --headless.";
            Console.Error.WriteLine(refused);
            MessageBox.Show(refused, BarText.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
#endif
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // The system's dialog font at 10 pt, for the bar and its windows: readable from an arm's length.
        Application.SetDefaultFont(new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, 10f));
        Application.Run(new RecorderBar());
        return 0;
    }
}
