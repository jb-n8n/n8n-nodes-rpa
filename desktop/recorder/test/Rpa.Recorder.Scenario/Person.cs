using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace Rpa.Recorder.Scenario;

/// <summary>
/// A stand-in for a person: performs the ERP Demo flow with real synthetic input (SendInput: the pointer moves to a
/// control's centre in steps, the button goes down and up; keys go down and up one by one, as a keyboard sends them).
/// It finds where to click through UI Automation, as a person finds it by looking. It never prints what it types.
/// </summary>
internal sealed class Person(int appProcessId, int seed) : IDisposable
{
    private readonly UIA3Automation _automation = new();
    private readonly Random _random = new(seed);
    private ConditionFactory Find => _automation.ConditionFactory;

    public void Dispose() => _automation.Dispose();

    /// <summary>Sign in, pick company 2000, type and paste the dates, search, click a result cell, export the line items
    /// into <paramref name="exportFile"/>, or, when it is null, under the name the Save dialog offers. v2: Find instead
    /// of Search, Reports > Export line items..., a confirmation. <paramref name="overwrite"/>: the file is there already,
    /// so Windows asks whether to replace it, and the person answers Yes.</summary>
    public void ErpFlow(string password, bool v2, string? exportFile, bool post = false, bool overwrite = false)
    {
        var login = Window(t => t == "ERP Demo - Sign in", 30000);
        Click(First(login, Find.ByAutomationId("txtUser")));
        Type("clerx"); Press(0x08); Type("k");     // a typo and a Backspace: the recording must still say clerk
        Press(0x09);                                // Tab to the password
        Type(password);
        Press(0x0D);                                // Enter signs in

        var main = Window(t => t == "ERP Demo - Line items", 15000);
        Click(First(main, Find.ByAutomationId("cmbCompany")));
        Click(Anywhere(Find.ByControlType(ControlType.ListItem).And(Find.ByName("2000")), 5000));
        Click(First(main, Find.ByAutomationId("txtDateFrom")));
        Press(0x41, ctrl: true);                    // Ctrl+A, then type over
        Type("2026-01-20");
        Click(First(main, Find.ByAutomationId("txtDateTo")));
        Press(0x41, ctrl: true);
        Paste("2026-11-30");                        // pasted, not typed
        Click(First(main, Find.ByAutomationId(v2 ? "btnFind" : "btnSearch")));
        var count = First(main, Find.ByAutomationId("lblResultCount"));
        Until(() => (count.Properties.Name.ValueOrDefault ?? "").EndsWith("line items", StringComparison.Ordinal), 5000, "the results");
        Click(First(main, Find.ByName("Vendor Row 1")));
        if (post) Click(First(main, Find.ByAutomationId("btnPost")));   // a write: the change file proposes to protect it
        if (!v2)
        {
            Click(First(main, Find.ByControlType(ControlType.MenuItem).And(Find.ByName("File"))));
            Click(Anywhere(Find.ByControlType(ControlType.MenuItem).And(Find.ByName("Export...")), 5000));
        }
        else
        {
            Click(First(main, Find.ByControlType(ControlType.MenuItem).And(Find.ByName("Reports"))));
            Click(Anywhere(Find.ByControlType(ControlType.MenuItem).And(Find.ByName("Export line items...")), 5000));
            Click(First(Window(t => t == "Confirm export", 10000), Find.ByAutomationId("btnConfirmExport")));
        }
        var dialog = Window(t => t == "Export line items", 15000);
        if (exportFile is null)
        {
            // The offered name is kept: Save at once. The dialog saves in the folder it used last and asks first when a
            // file of that name is there (an earlier pass left one): Yes then.
            Click(First(dialog, Find.ByControlType(ControlType.Button).And(Find.ByAutomationId("1"))));
            Until(() => !Shows("Export line items") || Shows("Confirm Save As"), 10000, "the Save dialog to close or ask");
            if (Shows("Confirm Save As"))
                Click(First(Window(t => t == "Confirm Save As", 5000), Find.ByControlType(ControlType.Button).And(Find.ByName("Yes"))));
            Until(() => !Shows("Export line items"), 10000, "the Save dialog to close");
            Thread.Sleep(1000);
            return;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(exportFile)!);
        const string Earlier = "an earlier export\n";
        if (overwrite) File.WriteAllText(exportFile, Earlier);
        else if (File.Exists(exportFile)) File.Delete(exportFile);
        Click(First(dialog, Find.ByControlType(ControlType.Edit).And(Find.ByAutomationId("1001"))));
        Press(0x41, ctrl: true);
        Type(exportFile);
        Click(First(dialog, Find.ByControlType(ControlType.Button).And(Find.ByAutomationId("1"))));
        if (overwrite)
        {
            Click(First(Window(t => t == "Confirm Save As", 10000), Find.ByControlType(ControlType.Button).And(Find.ByName("Yes"))));
            Until(() => File.ReadAllText(exportFile) != Earlier, 10000, "the file to be replaced");
        }
        Until(() => File.Exists(exportFile), 10000, "the exported file");
        Thread.Sleep(1000);
    }

    private AutomationElement Window(Func<string, bool> title, int timeoutMs)
    {
        AutomationElement? found = null;
        Until(() =>
        {
            foreach (var h in N.TopLevelWindows())
            {
                if (N.ProcessOf(h) == appProcessId && title(N.TitleOf(h))) { found = _automation.FromHandle(h); return true; }
            }
            return false;
        }, timeoutMs, "a window");
        Thread.Sleep(_random.Next(300, 700)); // a person looks at a new window first
        return found!;
    }

    /// <summary>Whether a window of the app with this title is shown.</summary>
    private bool Shows(string title) => N.TopLevelWindows().Any(h => N.ProcessOf(h) == appProcessId && N.TitleOf(h) == title);

    private static AutomationElement First(AutomationElement root, ConditionBase condition)
    {
        AutomationElement? found = null;
        Until(() =>
        {
            var e = root.FindFirstDescendant(condition);
            if (e is null || e.Properties.IsOffscreen.ValueOrDefault || e.Properties.BoundingRectangle.ValueOrDefault.IsEmpty) return false;
            found = e;
            return true;
        }, 5000, "an element");
        return found!;
    }

    /// <summary>In any window of the app: menus and drop-down lists open in windows of their own.</summary>
    private AutomationElement Anywhere(ConditionBase condition, int timeoutMs)
    {
        AutomationElement? found = null;
        Until(() =>
        {
            foreach (var h in N.TopLevelWindows())
            {
                if (N.ProcessOf(h) != appProcessId) continue;
                foreach (var e in _automation.FromHandle(h).FindAllDescendants(condition))
                {
                    if (e.Properties.IsOffscreen.ValueOrDefault || e.Properties.BoundingRectangle.ValueOrDefault.IsEmpty) continue;
                    found = e;
                    return true;
                }
            }
            return false;
        }, timeoutMs, "an element in a window of the app");
        return found!;
    }

    private static void Until(Func<bool> done, int timeoutMs, string what)
    {
        var clock = Stopwatch.StartNew();
        while (true)
        {
            try { if (done()) return; } catch (Exception) { /* the element is still changing */ }
            if (clock.ElapsedMilliseconds > timeoutMs) throw new TimeoutException($"timed out waiting for {what}");
            Thread.Sleep(100);
        }
    }

    private void Click(AutomationElement element)
    {
        var r = element.Properties.BoundingRectangle.Value;
        var (x, y) = (r.X + r.Width / 2, r.Y + r.Height / 2);
        // Into an open menu a person moves down first, then across: a diagonal path over the menu bar opens the
        // neighbouring menu (WinForms switches menus on hover).
        if (element.Properties.ControlType.ValueOrDefault == ControlType.MenuItem) { N.GetCursorPos(out var c); MoveTo(c.X, y); }
        MoveTo(x, y);
        Thread.Sleep(_random.Next(40, 120));
        Mouse(0x0002);
        Thread.Sleep(_random.Next(60, 130));
        Mouse(0x0004);
        Thread.Sleep(_random.Next(300, 700));
    }

    private void MoveTo(int x, int y)
    {
        N.GetCursorPos(out var p);
        var steps = _random.Next(8, 16);
        for (var i = 1; i <= steps; i++)
        {
            var f = (double)i / steps;
            var (ex, ey) = i == steps ? (0, 0) : (_random.Next(-3, 4), _random.Next(-3, 4));
            var w = N.GetSystemMetrics(0);
            var h = N.GetSystemMetrics(1);
            var input = new N.INPUT { type = 0 };
            input.u.mi = new N.MOUSEINPUT { dx = ((int)(p.X + (x - p.X) * f) + ex) * 65535 / (w - 1), dy = ((int)(p.Y + (y - p.Y) * f) + ey) * 65535 / (h - 1), dwFlags = 0x0001 | 0x8000 };
            Send(input);
            Thread.Sleep(_random.Next(8, 20));
        }
    }

    private static void Mouse(uint flags)
    {
        var input = new N.INPUT { type = 0 };
        input.u.mi = new N.MOUSEINPUT { dwFlags = flags };
        Send(input);
    }

    private static void Key(ushort vk, bool up)
    {
        var extended = vk is >= 0x21 and <= 0x28 or 0x2D or 0x2E;
        var input = new N.INPUT { type = 1 };
        input.u.ki = new N.KEYBDINPUT { wVk = vk, wScan = (ushort)N.MapVirtualKey(vk, 0), dwFlags = (up ? 0x0002u : 0) | (extended ? 0x0001u : 0) };
        Send(input);
    }

    private void Press(ushort vk, bool ctrl = false)
    {
        if (ctrl) { Key(0x11, false); Thread.Sleep(_random.Next(30, 70)); }
        Key(vk, false); Thread.Sleep(_random.Next(40, 90)); Key(vk, true);
        if (ctrl) { Thread.Sleep(_random.Next(20, 50)); Key(0x11, true); }
        Thread.Sleep(_random.Next(150, 400));
    }

    private void Type(string text)
    {
        foreach (var c in text)
        {
            var scan = N.VkKeyScan(c);
            if (scan == -1) throw new InvalidOperationException("a character with no key on this keyboard");
            var (vk, shift) = ((ushort)(scan & 0xFF), (scan & 0x100) != 0);
            if (shift) Key(0x10, false);
            Key(vk, false); Thread.Sleep(_random.Next(25, 60)); Key(vk, true);
            if (shift) Key(0x10, true);
            Thread.Sleep(_random.Next(40, 140));
        }
        Thread.Sleep(_random.Next(150, 400));
    }

    private void Paste(string text)
    {
        System.Windows.Forms.Clipboard.SetText(text);
        Press(0x56, ctrl: true);
    }

    private static void Send(N.INPUT input)
    {
        if (N.SendInput(1, [input], Marshal.SizeOf<N.INPUT>()) != 1) throw new InvalidOperationException($"SendInput failed: {Marshal.GetLastWin32Error()}");
    }
}

internal static class N
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);

    public static int ProcessOf(IntPtr hwnd) { GetWindowThreadProcessId(hwnd, out var pid); return (int)pid; }
    public static string TitleOf(IntPtr hwnd) { var sb = new StringBuilder(512); GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }
    public static List<IntPtr> TopLevelWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, _) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
}
