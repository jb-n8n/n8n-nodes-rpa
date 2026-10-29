namespace ErpDemo;

/// <summary>
/// ERP Demo: a deliberately plain "legacy ERP" for desktop automation tests. Sign in (user <c>clerk</c>, password
/// <c>demo1234</c>), search line items by company code and date range, read the results, export them as CSV.
///
/// <code>ErpDemo.exe [--ui v1|v2]</code>
/// v2 is the same app after an "upgrade": the Search button is now "Find" (automation id btnFind), Export moved from
/// File to a new Reports menu ("Export line items..."), and a confirmation dialog appears before the Save dialog.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
#if ERP_DEMO_V2
        var ui = UiVersion.V2;
#else
        var ui = UiVersion.V1;
#endif
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] is "--ui" or "/ui" && i + 1 < args.Length)
            {
                switch (args[++i].ToLowerInvariant())
                {
                    case "v1": ui = UiVersion.V1; break;
                    case "v2": ui = UiVersion.V2; break;
                    default: return Usage();
                }
            }
            else return Usage();
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new LoginForm(ui));
        return 0;
    }

    private static int Usage()
    {
        MessageBox.Show("Usage: ErpDemo.exe [--ui v1|v2]", "ERP Demo", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 2;
    }
}

internal enum UiVersion { V1, V2 }
