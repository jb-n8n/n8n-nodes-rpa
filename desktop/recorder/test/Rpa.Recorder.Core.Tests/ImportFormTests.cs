namespace Rpa.Recorder.Core.Tests;

/// <summary>Open the import form: which addresses the bar opens, asks about first or refuses, what it opens, where it
/// keeps the address, and what the Saved stage says once the form is open.</summary>
public sealed class ImportFormTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "import-form-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_folder)) Directory.Delete(_folder, recursive: true);
    }

    [Theory]
    [InlineData("https://n8n.example.com/form/import-a-bot", "https://n8n.example.com/form/import-a-bot")]
    [InlineData("  HTTPS://N8N.Example.com:8443/form/x?y=1#z \r\n", "https://n8n.example.com:8443/form/x?y=1#z")]
    [InlineData("https://your-n8n/form/a b", null)]
    [InlineData("http://localhost:5678/form/import", "http://localhost:5678/form/import")]
    [InlineData("http://127.0.0.1:5678/form/import", "http://127.0.0.1:5678/form/import")]
    [InlineData("http://[::1]:5678/form/import", "http://[::1]:5678/form/import")]
    [InlineData("http://10.1.2.3/form/import", "http://10.1.2.3/form/import")]
    [InlineData("http://172.16.0.9/form/import", "http://172.16.0.9/form/import")]
    [InlineData("http://172.31.255.1/form/import", "http://172.31.255.1/form/import")]
    [InlineData("http://192.168.1.20:5678/form/import", "http://192.168.1.20:5678/form/import")]
    [InlineData("http://n8n-box:5678/form/import", "http://n8n-box:5678/form/import")]
    public void An_https_address_or_an_http_address_on_this_machine_or_network_opens_as_its_normalised_form(string typed, string? opened)
    {
        var address = ImportForm.Check(typed);
        if (opened is null)
        {
            Assert.Equal(AddressVerdict.Refused, address.Verdict);
            return;
        }
        Assert.Equal(new FormAddress(AddressVerdict.Open, opened, null), address);
    }

    [Theory]
    [InlineData("http://n8n.example.com/form/import")]
    [InlineData("http://172.32.0.1/form/import")]
    [InlineData("http://192.169.0.1/form/import")]
    [InlineData("http://11.0.0.1/form/import")]
    [InlineData("http://127.0.0.2/form/import")]
    [InlineData("http://intranet./form/import")]
    public void Another_http_address_is_asked_about_first(string typed)
    {
        var address = ImportForm.Check(typed);
        Assert.Equal(AddressVerdict.AskFirst, address.Verdict);
        Assert.StartsWith("http://", address.Target);
        Assert.Null(address.Problem);
        Assert.Equal("This address starts with http://, so the form's login would travel unencrypted.", DialogText.PlainHttp.Text);
        Assert.Equal(("Continue", "Back"), (DialogText.PlainHttp.Action, DialogText.PlainHttp.Cancel));
    }

    [Theory]
    [InlineData("", "Type the form's address.")]
    [InlineData("   ", "Type the form's address.")]
    [InlineData("file:///C:/Windows/System32/calc.exe", "The address must start with https:// or http://.")]
    [InlineData("javascript:alert(1)", "The address must start with https:// or http://.")]
    [InlineData(@"\\server\share\form.html", "The address may not hold spaces, line breaks or \\.")]
    [InlineData("//server/share", "The address must start with https:// or http://.")]
    [InlineData("ftp://n8n.example.com/form", "The address must start with https:// or http://.")]
    [InlineData("n8n.example.com/form/import", "The address must start with https:// or http://.")]
    [InlineData("https:n8n.example.com/form", "The address must start with https:// or http://.")]
    [InlineData("https:/n8n.example.com/form", "The address must start with https:// or http://.")]
    [InlineData(@"https:\\n8n.example.com\form", "The address may not hold spaces, line breaks or \\.")]
    [InlineData("https://n8n.example.com/form\nimport", "The address may not hold spaces, line breaks or \\.")]
    [InlineData("https://n8n.example.com/form\u0000", "The address may not hold spaces, line breaks or \\.")]
    [InlineData("https://n8n.example.com/a form", "The address may not hold spaces, line breaks or \\.")]
    [InlineData("https://user:password@n8n.example.com/form", "Leave the login out of the address: the browser asks for it.")]
    [InlineData("https://user@n8n.example.com/form", "Leave the login out of the address: the browser asks for it.")]
    [InlineData("https://@n8n.example.com/form", "Leave the login out of the address: the browser asks for it.")]
    [InlineData("http://user:pw@localhost:5678/form", "Leave the login out of the address: the browser asks for it.")]
    public void Any_other_address_is_refused_with_what_is_wrong(string typed, string problem)
    {
        Assert.Equal(new FormAddress(AddressVerdict.Refused, null, problem), ImportForm.Check(typed));
    }

    [Fact]
    public void A_very_long_address_is_refused()
    {
        Assert.Equal("The address is too long.", ImportForm.Check("https://n8n.example.com/" + new string('a', ImportForm.MaxLength)).Problem);
    }

    [Fact]
    public void What_is_opened_is_an_escaped_https_or_http_address_and_nothing_else()
    {
        // Characters a shell or a command line reads are escaped: the opened string starts with the scheme and holds no quote.
        var address = ImportForm.Check("https://n8n.example.com/form/\"x\"^&|<>");
        Assert.Equal(AddressVerdict.Open, address.Verdict);
        Assert.Equal("https://n8n.example.com/form/%22x%22%5E&%7C%3C%3E", address.Target);
    }

    [Fact]
    public void The_address_is_kept_per_user_in_the_recorders_folder_and_checked_again_when_read()
    {
        var path = ImportForm.PathIn(_folder)!;
        Assert.Equal(Path.Combine(_folder, "RPA Recorder", "import-form.txt"), path);
        Assert.Null(ImportForm.PathIn(""));
        Assert.Null(ImportForm.Kept(path));

        Assert.True(ImportForm.Keep(path, ImportForm.Check(" https://n8n.example.com/form/import ")));
        Assert.Equal("https://n8n.example.com/form/import", File.ReadAllText(path));
        Assert.Equal(new FormAddress(AddressVerdict.Open, "https://n8n.example.com/form/import", null), ImportForm.Kept(path));

        // An http address the person chose to continue with is kept as such.
        Assert.True(ImportForm.Keep(path, ImportForm.Check("http://n8n.example.com/form/import")));
        Assert.Equal(AddressVerdict.AskFirst, ImportForm.Kept(path)!.Verdict);

        // A refused address is never kept, and a file changed to hold one reads as no address.
        Assert.False(ImportForm.Keep(path, ImportForm.Check("file:///C:/x")));
        File.WriteAllText(path, "javascript:alert(1)");
        Assert.Null(ImportForm.Kept(path));
        File.WriteAllText(path, "https://n8n.example.com/" + new string('a', 3 * ImportForm.MaxLength));
        Assert.Null(ImportForm.Kept(path));
        Assert.Null(ImportForm.Kept(null));
    }

    [Fact]
    public void A_failure_to_keep_or_read_the_address_is_reported_as_none()
    {
        // The recorder's folder is a file: nothing can be written there.
        Directory.CreateDirectory(_folder);
        File.WriteAllText(Path.Combine(_folder, "RPA Recorder"), "");
        var path = ImportForm.PathIn(_folder)!;
        Assert.False(ImportForm.Keep(path, ImportForm.Check("https://n8n.example.com/form/import")));
        Assert.Null(ImportForm.Kept(path));
        Assert.False(ImportForm.Keep(null, ImportForm.Check("https://n8n.example.com/form/import")));
    }

    [Fact]
    public void The_window_and_the_button_say_what_they_do()
    {
        Assert.Equal("Open the import form", NextSteps.OpenForm);
        Assert.Equal("Change address…", NextSteps.ChangeAddress);
        Assert.Equal("Address of n8n's Import a bot form", DialogText.AddressLabel);
        Assert.Equal("The setup command prints it. It looks like https://your-n8n/form/…", DialogText.AddressNote);
        Assert.Equal(("OK", "Cancel"), (DialogText.Ok, DialogText.Cancel));
        Assert.Equal("The import form's address", DialogText.AddressTitle);
        Assert.Equal("The browser did not start: No program opens web addresses. Choose Show the file instead.", NextSteps.BrowserNotStarted("No program opens web addresses."));
    }

    [Fact]
    public void Once_the_form_is_open_the_import_line_says_to_paste_the_path_or_where_to_find_the_file()
    {
        Assert.Equal("Upload it in n8n's Import a bot form.", NextSteps.Import().Detail);
        Assert.Equal(new NextLine("2. Import the recording in n8n", "The form is open in your browser. In its file box, paste the path (Ctrl+V): it is on the clipboard.", "Show the file", null, true),
            NextSteps.Import(new FormOpened(true, "ERP line items.rpa-recording.json", @"Documents\RPA recordings")));
        Assert.Equal("Choose the file ERP line items.rpa-recording.json in Documents\\RPA recordings.",
            NextSteps.Import(new FormOpened(false, "ERP line items.rpa-recording.json", @"Documents\RPA recordings")).Detail);
    }
}
