using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

/// <summary>
/// The ERP Demo reference flow as the Windows layer reports it: sign in, pick company code 2000, type and paste the
/// dates, search, click a result cell, export the line items through File > Export... and the Save dialog. The elements,
/// windows and times are those UI Automation gave on a real Windows machine for this flow.
/// </summary>
internal static class ErpDemoObservations
{
    public const string ExePath = @"C:\Program Files\RPA Runner\erp-demo\v1\ErpDemo.exe";
    private const string EditClass = "WindowsForms10.Edit.app.0.19fd5c7_r3_ad1";

    private static readonly WindowFacts SignIn = new("erpdemo.exe", "ERP Demo - Sign in", WinFormsClass);
    private static readonly WindowFacts Main = new("erpdemo.exe", "ERP Demo - Line items", WinFormsClass);
    private static readonly WindowFacts FileMenu = new("erpdemo.exe", "", "WindowsForms10.Window.808.app.0.19fd5c7_r3_ad1");
    private static readonly WindowFacts SaveDialog = new("erpdemo.exe", "Export line items", "#32770");

    private static readonly ElementFacts LoginForm = El("Window", "LoginForm", "ERP Demo - Sign in", WinFormsClass);
    private static readonly ElementFacts LoginPane = El("Pane", "", "", WinFormsClass);
    private static readonly ElementFacts User = El("Edit", "txtUser", "User name", EditClass, false, false, LoginPane, LoginForm);
    private static readonly ElementFacts Password = El("Edit", "txtPassword", "Password", EditClass, true, false, LoginPane, LoginForm);

    private static readonly ElementFacts MainForm = El("Window", "MainForm", "ERP Demo - Line items", WinFormsClass);
    private static readonly ElementFacts Detail = El("Pane", "", "Detail", WinFormsClass);
    private static readonly ElementFacts Search = El("Group", "grpSearch", "Line items", WinFormsClass);
    private static readonly ElementFacts Company = El("ComboBox", "cmbCompany", "Company code", "WindowsForms10.ComboBox.app.0.19fd5c7_r3_ad1", false, false, Detail, Search, MainForm);
    private static readonly ElementFacts Item2000 = El("ListItem", "", "2000", "", false, false,
        El("List", "1000", "Company code", "ComboLBox"), Company, Detail, Search, MainForm);
    private static readonly ElementFacts DateFrom = El("Edit", "txtDateFrom", "Date from", EditClass, false, false, Detail, Search, MainForm);
    private static readonly ElementFacts DateTo = El("Edit", "txtDateTo", "Date to", EditClass, false, false, Detail, Search, MainForm);
    private static readonly ElementFacts SearchButton = El("Button", "btnSearch", "Search", "WindowsForms10.Button.app.0.19fd5c7_r3_ad1", false, false, Detail, Search, MainForm);
    private static readonly ElementFacts VendorCell = El("DataItem", "4237251161", "Vendor Row 1", "", false, false,
        El("Unknown", "", "Row 1"), El("DataGrid", "gridResults", "Results", WinFormsClass), MainForm);
    private static readonly ElementFacts MenuBar = El("MenuBar", "mainMenu", "6 line items", WinFormsClass);
    private static readonly ElementFacts File = El("MenuItem", "", "File", "", false, false, MenuBar, MainForm);
    private static readonly ElementFacts Export = El("MenuItem", "", "Export...", "", false, false,
        El("Menu", "", "File", "WindowsForms10.Window.808.app.0.19fd5c7_r3_ad1"), El("MenuItem", "", "File"), MenuBar, MainForm);

    private static readonly ElementFacts Dialog = El("Window", "", "Export line items", "#32770");
    private static readonly ElementFacts FileName = El("Edit", "1001", "File name:", "Edit", false, false,
        El("ComboBox", "FileNameControlHost", "File name:", "AppControlHost"), El("Pane", "", "", "DUIViewWndClassName"), Dialog, MainForm);
    private static readonly ElementFacts Save = El("Button", "1", "Save", "Button", false, false, Dialog, MainForm);

    /// <summary>The observations; <paramref name="password"/> is what the Windows layer wrongly reports as the password
    /// field's value (null, as it should be: a secret field is never read).</summary>
    public static Observation[] List(string? password = null) =>
    [
        new AppStarted(Parse("22:59:16.2298304"), ExePath, [], SignIn),
        new MouseDown(Parse("22:59:16.2298304"), SignIn, User, 1),
        Typing("22:59:16.6", SignIn, User), Typing("22:59:17.7", SignIn, User), Typing("22:59:17.934", SignIn, User), Typing("22:59:18.1", SignIn, User),
        new FieldLeft(Parse("22:59:18.760"), SignIn, User, "clerk", null),
        new KeyDown(Parse("22:59:18.760"), SignIn, User, "Tab", false),
        Typing("22:59:19.0253827", SignIn, Password), Typing("22:59:19.4", SignIn, Password), Typing("22:59:20.1", SignIn, Password),
        new FieldLeft(Parse("22:59:20.5266375"), SignIn, Password, password, null),
        new KeyDown(Parse("22:59:20.5266375"), SignIn, Password, "Enter", false),
        new MouseDown(Parse("22:59:21.8851309"), Main, Company, 1),
        new MouseDown(Parse("22:59:22.9162750"), Main, Item2000, 1),
        new MouseDown(Parse("22:59:23.8537094"), Main, DateFrom, 1),
        Typing("22:59:24.650", Main, DateFrom), Typing("22:59:25.2", Main, DateFrom), Typing("22:59:26.3", Main, DateFrom),
        new FieldLeft(Parse("22:59:27.1662550"), Main, DateFrom, "2026-01-20", null),
        new MouseDown(Parse("22:59:27.1662550"), Main, DateTo, 1),
        Typing("22:59:27.911", Main, DateTo), Typing("22:59:28.465", Main, DateTo),
        new FieldLeft(Parse("22:59:29.1348351"), Main, DateTo, "2026-11-30", null),
        new MouseDown(Parse("22:59:29.1348351"), Main, SearchButton, 1),
        new MouseDown(Parse("22:59:30.2291062"), Main, VendorCell, 1),
        new MouseDown(Parse("22:59:31.4786295"), Main, File, 1),
        new MouseDown(Parse("22:59:32.7285972"), FileMenu, Export, 1),
        new MouseDown(Parse("22:59:34.0412074"), SaveDialog, FileName, 1),
        Typing("22:59:35.084", SaveDialog, FileName), Typing("22:59:38.2", SaveDialog, FileName),
        new FieldLeft(Parse("22:59:43.4789525"), SaveDialog, FileName, @"C:\Users\clerk\Documents\out\line-items.csv", null),
        new MouseDown(Parse("22:59:43.4789525"), SaveDialog, Save, 1),
    ];

    private static KeyDown Typing(string time, WindowFacts window, ElementFacts focused) => new(Parse(time), window, focused, "", true);
}
