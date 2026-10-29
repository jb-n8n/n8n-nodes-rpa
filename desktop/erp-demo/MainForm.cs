using System.Globalization;

namespace ErpDemo;

/// <summary>
/// The main window: menu, the "Line items" search (company code, date range, Search), the results grid, a detail field
/// and Export. Control and menu item names are the automation ids UI Automation reports.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly UiVersion _ui;
    private readonly ComboBox _company;
    private readonly TextBox _from;
    private readonly TextBox _to;
    private readonly DataGridView _grid;
    private readonly TextBox _detail;
    private readonly Label _count;
    private readonly ToolStripStatusLabel _status;
    private IReadOnlyList<LineItem> _rows = [];

    public MainForm(UiVersion ui, string user)
    {
        _ui = ui;
        Name = "MainForm";
        Text = "ERP Demo - Line items";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(900, 560);
        MinimumSize = new Size(700, 400);
        Font = new Font("Segoe UI", 9f);

        // Menu. v1: File > Export...; v2: Reports > Export line items... (File keeps only Exit).
        var menu = new MenuStrip { Name = "mainMenu" };
        var file = new ToolStripMenuItem("&File") { Name = "mnuFile" };
        if (ui == UiVersion.V1)
        {
            var export = new ToolStripMenuItem("&Export...") { Name = "mnuExport" };
            export.Click += (_, _) => Export();
            file.DropDownItems.Add(export);
            file.DropDownItems.Add(new ToolStripSeparator());
        }
        var exit = new ToolStripMenuItem("E&xit") { Name = "mnuExit" };
        exit.Click += (_, _) => Close();
        file.DropDownItems.Add(exit);
        menu.Items.Add(file);
        if (ui == UiVersion.V2)
        {
            var reports = new ToolStripMenuItem("&Reports") { Name = "mnuReports" };
            var export = new ToolStripMenuItem("&Export line items...") { Name = "mnuExportLineItems" };
            export.Click += (_, _) => Export();
            reports.DropDownItems.Add(export);
            menu.Items.Add(reports);
        }
        var help = new ToolStripMenuItem("&Help") { Name = "mnuHelp" };
        var about = new ToolStripMenuItem("&About") { Name = "mnuAbout" };
        about.Click += (_, _) => MessageBox.Show(this, $"ERP Demo {(_ui == UiVersion.V1 ? "1.0" : "2.0")}\nA sample app for RPA desktop tests.", "About ERP Demo");
        help.DropDownItems.Add(about);
        menu.Items.Add(help);
        MainMenuStrip = menu;

        // Search panel.
        var search = new GroupBox { Name = "grpSearch", Text = "Line items", Dock = DockStyle.Top, Height = 70 };
        var row = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(6, 4, 6, 0) };
        row.Controls.Add(new Label { Name = "lblCompany", Text = "Company code", AutoSize = true, Margin = new Padding(0, 8, 4, 0) });
        _company = new ComboBox { Name = "cmbCompany", AccessibleName = "Company code", DropDownStyle = ComboBoxStyle.DropDownList, Width = 90 };
        _company.Items.AddRange(LineItems.Companies);
        row.Controls.Add(_company);
        row.Controls.Add(new Label { Name = "lblFrom", Text = "Date from", AutoSize = true, Margin = new Padding(16, 8, 4, 0) });
        _from = new TextBox { Name = "txtDateFrom", AccessibleName = "Date from", Text = "2026-01-01", Width = 90 };
        row.Controls.Add(_from);
        row.Controls.Add(new Label { Name = "lblTo", Text = "Date to", AutoSize = true, Margin = new Padding(16, 8, 4, 0) });
        _to = new TextBox { Name = "txtDateTo", AccessibleName = "Date to", Text = "2026-12-31", Width = 90 };
        row.Controls.Add(_to);
        // v2 renames the button (text and automation id), as app upgrades do.
        var go = ui == UiVersion.V1
            ? new Button { Name = "btnSearch", Text = "Search", AutoSize = true, Margin = new Padding(16, 3, 3, 3) }
            : new Button { Name = "btnFind", Text = "Find", AutoSize = true, Margin = new Padding(16, 3, 3, 3) };
        go.Click += (_, _) => Search();
        row.Controls.Add(go);
        // A write: posts the selected line item (the runner's policy declares btnPost a write control).
        var post = new Button { Name = "btnPost", Text = "Post", AutoSize = true, Margin = new Padding(6, 3, 3, 3) };
        post.Click += (_, _) => Post();
        row.Controls.Add(post);
        _count = new Label { Name = "lblResultCount", AccessibleName = "Result count", Text = "", AutoSize = true, Margin = new Padding(16, 8, 0, 0) };
        row.Controls.Add(_count);
        search.Controls.Add(row);
        AcceptButton = go;

        // Results and detail.
        _grid = new DataGridView
        {
            Name = "gridResults",
            AccessibleName = "Results",
            Dock = DockStyle.Fill,
            ReadOnly = true,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            RowHeadersVisible = false,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
        };
        foreach (var name in new[] { "Document", "Date", "Company", "Vendor", "Amount", "Currency", "Status" })
            _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "col" + name, HeaderText = name, SortMode = DataGridViewColumnSortMode.NotSortable });
        _grid.SelectionChanged += (_, _) => ShowDetail();

        var detailPanel = new Panel { Name = "pnlDetail", Dock = DockStyle.Bottom, Height = 70, Padding = new Padding(6) };
        _detail = new TextBox { Name = "txtDetail", AccessibleName = "Detail", ReadOnly = true, Multiline = true, Dock = DockStyle.Fill };
        detailPanel.Controls.Add(_detail);
        detailPanel.Controls.Add(new Label { Name = "lblDetail", Text = "Detail", Dock = DockStyle.Top, Height = 18 });

        var bar = new StatusStrip { Name = "statusBar" };
        _status = new ToolStripStatusLabel($"Signed in as {user}") { Name = "lblStatus" };
        bar.Items.Add(_status);

        Controls.Add(_grid);
        Controls.Add(detailPanel);
        Controls.Add(search);
        Controls.Add(menu);
        Controls.Add(bar);
    }

    private void Search()
    {
        if (_company.SelectedItem is not string company)
        {
            _count.Text = "Choose a company code.";
            return;
        }
        if (!DateOnly.TryParseExact(_from.Text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from) ||
            !DateOnly.TryParseExact(_to.Text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to))
        {
            _count.Text = "Dates must be YYYY-MM-DD.";
            return;
        }
        _rows = LineItems.Search(company, from, to);
        _grid.Rows.Clear();
        foreach (var r in _rows) _grid.Rows.Add(r.Document, r.DateText, r.Company, r.Vendor, r.AmountText, r.Currency, r.Status);
        _count.Text = $"{_rows.Count} line items";
        if (_grid.Rows.Count > 0) _grid.Rows[0].Selected = true;
        ShowDetail();
    }

    private void ShowDetail()
    {
        var i = _grid.SelectedRows.Count > 0 ? _grid.SelectedRows[0].Index : -1;
        _detail.Text = i >= 0 && i < _rows.Count
            ? $"{_rows[i].Document} {_rows[i].DateText} {_rows[i].Vendor} {_rows[i].AmountText} {_rows[i].Currency} {_rows[i].Status}"
            : "";
    }

    private void Post()
    {
        var i = _grid.SelectedRows.Count > 0 ? _grid.SelectedRows[0].Index : -1;
        if (i < 0 || i >= _rows.Count) return;
        var rows = _rows.ToList();
        rows[i] = rows[i] with { Status = "Posted" };
        _rows = rows;
        _grid.Rows[i].Cells["colStatus"].Value = "Posted";
        ShowDetail();
        _status.Text = $"Posted {rows[i].Document}";
    }

    private void Export()
    {
        if (_ui == UiVersion.V2)
        {
            using var confirm = new ConfirmExportForm(_rows.Count);
            if (confirm.ShowDialog(this) != DialogResult.OK) return;
        }
        using var dlg = new SaveFileDialog
        {
            Title = "Export line items",
            Filter = "CSV files (*.csv)|*.csv|All files (*.*)|*.*",
            FileName = "line-items.csv",
            DefaultExt = "csv",
            AddExtension = true,
            OverwritePrompt = true,
            RestoreDirectory = true,
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        File.WriteAllBytes(dlg.FileName, LineItems.ToCsv(_rows));
        _status.Text = $"Exported {_rows.Count} line items";
    }
}

/// <summary>v2 only: asks before exporting.</summary>
internal sealed class ConfirmExportForm : Form
{
    public ConfirmExportForm(int count)
    {
        Name = "ConfirmExportForm";
        Text = "Confirm export";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(340, 120);
        Font = new Font("Segoe UI", 9f);
        Controls.Add(new Label { Name = "lblConfirm", Text = $"Export {count} line items to a CSV file?", AutoSize = true, Location = new Point(16, 20) });
        var ok = new Button { Name = "btnConfirmExport", Text = "Continue", DialogResult = DialogResult.OK, Location = new Point(150, 70), AutoSize = true };
        var cancel = new Button { Name = "btnCancelExport", Text = "Cancel", DialogResult = DialogResult.Cancel, Location = new Point(240, 70), AutoSize = true };
        Controls.Add(ok);
        Controls.Add(cancel);
        AcceptButton = ok;
        CancelButton = cancel;
    }
}
