using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// The recorder's bar: a window that stays on top at the top right of the screen. At the top, the state in words with
/// a coloured dot (red while recording, amber while paused), one sentence that says what to do now, and the notice
/// line. Below, what the stage needs: Ready offers two ways to choose the app; Recording and Paused show Pause or
/// Resume, Finish, the numbered steps and the step actions (Delete step, Make secret…); after Finish, one page asks
/// which recorded values change from run to run, the one place where a value becomes a variable (Back returns to the
/// list, paused, or to Finished once the recording has ended); Finished adds the name, Save, and Back to that page;
/// after saving, what to do next (allow the app with the policy tool, import the recording in n8n) and Record another. Everything the bar decides or says is in Rpa.Recorder.Core
/// (BarText, StepRows, ValuesPage, DialogText, NoticeLine, SaveNames, NextSteps, BarLayout); this class shows it, and
/// writes its stages and buttons to BarLog. The bar's own windows are never recorded, and after a bar action while
/// recording the app gets the focus back.
/// </summary>
internal sealed class RecorderBar : Form
{
    // Colour is used for the state and for notices to check, nothing else. The primary button of a stage is the
    // window's default button, which Windows draws in its own accent.
    internal static readonly Color Red = Color.FromArgb(196, 43, 28);
    internal static readonly Color Amber = Color.FromArgb(157, 93, 0);

    private readonly string _documents;
    private readonly string? _policyTool;
    private readonly NoticeLine _notices = new();
    private readonly BarLog _log = new(BarLog.PathIn(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)), () => DateTimeOffset.Now);
    private readonly string? _formPath = ImportForm.PathIn(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    // The import form's kept address (ImportForm.Kept), and what Open the import form did for the saved recording.
    private FormAddress? _form;
    private FormOpened? _formOpened;
    private Capture _capture;
    private BarStage _stage = BarStage.Ready;
    private string? _starting;
    private string _folder;
    private IReadOnlyList<RecordedStep> _shown = [];
    private IReadOnlyList<RecordedStep>? _saved;
    private string? _savedRecording, _savedChange;
    private AllowState _allow = AllowState.NotDone;
    // The recording has ended (Finish, then the name and Save): it cannot resume, so Back on the values page leads to Finished.
    private bool _ended;
    private bool _asking;
    // A screen narrower than 1280 at 100 % (BarLayout.WidthFor): the bar starts narrower and Ready says it can be moved.
    private bool _narrow;
    // The stage and parts the bar last grew for (KeepListRows): it grows when they change, not for every new step.
    private (BarStage, BarPart)? _grownFor;

    private readonly TableLayoutPanel _layout = Column(fill: true);
    private readonly List<Label> _wrapping = [];
    private readonly ToolTip _tip = new();
    private readonly Label _dot = new() { Text = "●", AutoSize = true, UseMnemonic = false, Margin = Padding.Empty };
    private readonly Label _state = new() { AutoSize = true, UseMnemonic = false, Margin = new Padding(BarLayout.Tight, 0, 0, 0) };
    private readonly Label _guidance;
    private readonly Label _notice = new() { AutoSize = false, AutoEllipsis = true, UseMnemonic = false, Dock = DockStyle.Fill, Margin = Padding.Empty };
    private readonly LinkLabel _earlier = new() { AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Right, Margin = new Padding(BarLayout.Space, 0, 0, 0), Visible = false };
    private readonly FlowLayoutPanel _startRow = Row();
    private readonly Button _startApp = SmallDialog.NewButton(BarText.StartApp);
    private readonly Button _useOpen = SmallDialog.NewButton(BarText.UseOpenApp);
    private readonly Label _readyText;
    private readonly FlowLayoutPanel _recordRow = Row();
    private readonly Button _pause = SmallDialog.NewButton(BarText.PauseButton(BarStage.Recording));
    private readonly Button _finish = SmallDialog.NewButton(BarText.Finish);
    private readonly Panel _listArea = new() { Dock = DockStyle.Fill, Margin = new Padding(0, BarLayout.Space, 0, 0) };
    private readonly StepList _list = new() { Dock = DockStyle.Fill };
    private readonly Label _empty = new() { Text = BarText.EmptyList, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = SystemColors.GrayText, BackColor = SystemColors.Window, BorderStyle = BorderStyle.FixedSingle, UseMnemonic = false };
    private readonly Label _readHint;
    private readonly Label _actionHint;
    private readonly FlowLayoutPanel _actionRow = Row();
    private readonly Button _delete = SmallDialog.NewButton(BarText.DeleteStep);
    private readonly Button _secret = SmallDialog.NewButton(BarText.MakeSecret);
    // The values page (Values): its sentence, a scrolling table in the list's place, a problem line and Back / Continue.
    private readonly Label _valuesIntro;
    private readonly Panel _valuesArea = new() { Dock = DockStyle.Fill, AutoScroll = true, BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(BarLayout.Space, BarLayout.Tight, BarLayout.Space, 0), Visible = false };
    private readonly TableLayoutPanel _valuesTable = new() { ColumnCount = 3, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, Margin = Padding.Empty };
    private readonly List<Label> _valueTexts = [];
    private readonly Label _valuesProblem;
    private readonly FlowLayoutPanel _valuesButtons = Row();
    private readonly Button _back = SmallDialog.NewButton(ValuesPage.Back);
    private readonly Button _continue = SmallDialog.NewButton(ValuesPage.Continue);
    // The page's rows as the person left them; kept over Back, so that Finish shows the same choices again.
    private ValueRow[]? _valueRows;
    private readonly TableLayoutPanel _saveBlock = Column();
    private readonly TextBox _name = new() { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
    private readonly Label _folderLine;
    private readonly Button _changeFolder = SmallDialog.NewButton(BarText.ChangeFolder);
    private readonly Button _save = SmallDialog.NewButton(BarText.Save);
    // Finished's Back to the values page: the page's own Back, in the same place beside the stage's primary button.
    private readonly Button _finishedBack = SmallDialog.NewButton(ValuesPage.Back);
    private readonly TableLayoutPanel _nextBlock = Column();
    private readonly Label _allowTitle, _allowDetail, _importTitle, _importDetail;
    private readonly TextBox _allowCommand = new() { ReadOnly = true, Dock = DockStyle.Fill, BackColor = SystemColors.Window, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
    private readonly Button _allowButton = SmallDialog.NewButton(NextSteps.AllowButton);
    private readonly Button _showFile = SmallDialog.NewButton(NextSteps.ShowFile);
    private readonly FlowLayoutPanel _importRow = Row();
    private readonly Button _openForm = SmallDialog.NewButton(NextSteps.OpenForm);
    private readonly LinkLabel _changeAddress = new() { Text = NextSteps.ChangeAddress, AutoSize = true, UseMnemonic = false, Margin = new Padding(BarLayout.Space, 6, 0, 0) };
    private readonly Button _recordAnother = SmallDialog.NewButton(BarText.RecordAnother);

    public RecorderBar()
    {
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = BarText.Title;
        TopMost = true;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = SystemColors.Window;
        Size = new Size(BarLayout.Width, BarLayout.Height);
        MinimumSize = new Size(BarLayout.MinWidth, BarLayout.MinHeight);
        Padding = new Padding(BarLayout.Edge);

        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        _documents = documents.Length > 0 ? documents : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        _folder = SaveNames.DefaultFolder(_documents);
        _policyTool = NextSteps.FindPolicyTool(AppContext.BaseDirectory, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), File.Exists);
        _form = ImportForm.Kept(_formPath);

        _guidance = Wrap();
        _readyText = Wrap(ReadyText());
        _readHint = Wrap(BarText.ReadHint, quiet: true);
        _actionHint = Wrap(quiet: true);
        _folderLine = Wrap(quiet: true);
        _allowTitle = Wrap();
        _allowDetail = Wrap(quiet: true);
        _importTitle = Wrap();
        _importDetail = Wrap(quiet: true);
        _valuesIntro = Wrap(ValuesPage.Intro, quiet: true);
        _valuesProblem = Wrap();
        _valuesProblem.ForeColor = Amber;
        Build();
        _capture = NewCapture();

        // The bar log: each button by its name and the stage it was pressed in, before its action runs.
        foreach (var (button, name) in new[]
                 {
                     (_startApp, BarButton.StartApp), (_useOpen, BarButton.UseOpenApp), (_pause, BarButton.PauseOrResume), (_finish, BarButton.Finish),
                     (_back, BarButton.Back), (_finishedBack, BarButton.Back), (_continue, BarButton.Continue), (_delete, BarButton.DeleteStep), (_secret, BarButton.MakeSecret),
                     (_changeFolder, BarButton.ChangeFolder), (_save, BarButton.Save), (_allowButton, BarButton.Allow), (_showFile, BarButton.ShowFile),
                     (_openForm, BarButton.OpenImportForm),
                     (_recordAnother, BarButton.RecordAnother),
                 })
            button.Click += (_, _) => _log.Pressed(name, _stage);
        _startApp.Click += async (_, _) => await StartApp();
        _useOpen.Click += (_, _) => UseOpenApp();
        _pause.Click += (_, _) => TogglePause();
        _finish.Click += (_, _) => Finish();
        _back.Click += (_, _) => GoBack();
        _finishedBack.Click += (_, _) => GoBack();
        _continue.Click += (_, _) => ContinueFromValues();
        _valuesArea.ClientSizeChanged += (_, _) => FitValues();
        // Once finished or saved, selecting a step shows the step actions again.
        _list.SelectedIndexChanged += (_, _) => { if (_stage is BarStage.Finished or BarStage.Saved) ShowStage(_stage); else ShowActions(); };
        _delete.Click += (_, _) => Delete();
        _secret.Click += (_, _) => MakeSecret();
        _changeFolder.Click += (_, _) => ChangeFolder();
        _save.Click += (_, _) => Save();
        _allowButton.Click += async (_, _) => await Allow();
        _showFile.Click += (_, _) => ShowFile();
        _openForm.Click += (_, _) => OpenImportForm();
        _changeAddress.LinkClicked += (_, _) =>
        {
            _log.Pressed(BarButton.ChangeFormAddress, _stage);
            AskAddress(_form?.Target ?? "");
        };
        _recordAnother.Click += (_, _) => RecordAnother();
        _earlier.LinkClicked += (_, _) => ShowEarlierNotices();
        _layout.SizeChanged += (_, _) => FitSizes();

        Load += (_, _) =>
        {
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
            // The working area in 100 % pixels decides the starting width.
            var width = BarLayout.WidthFor(area.Width * 96 / DeviceDpi);
            _narrow = width < BarLayout.Width;
            _readyText.Text = ReadyText();
            Bounds = BarLayout.Initial(area, new Size(LogicalToDeviceUnits(width), Height), LogicalToDeviceUnits(BarLayout.Space));
            FitSizes();
        };
        // TopMost set before the handle exists does not always survive the window's creation (seen on Windows Server
        // 2022): set it again once the bar is shown, so that it stays on top of the app.
        Shown += (_, _) => { TopMost = false; TopMost = true; };
        FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing && StepRows.Unsaved(_saved, _shown) && !Confirm(DialogText.CloseUnsaved(_shown.Count))) e.Cancel = true;
        };
        FormClosed += (_, _) => _capture.Dispose();
        ShowStage(BarStage.Ready);
        ResumeLayout(false);
        PerformLayout();
    }

    // ---- Layout ----

    private void Build()
    {
        var bold = new Font(Font.FontFamily, Font.SizeInPoints + 1f, FontStyle.Bold);
        _dot.Font = bold;
        _state.Font = bold;
        _allowTitle.Font = _importTitle.Font = new Font(Font, FontStyle.Bold);

        var header = Row();
        header.WrapContents = false;
        header.Controls.AddRange([_dot, _state]);

        var noticeRow = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, Dock = DockStyle.Fill, Margin = new Padding(0, BarLayout.Tight, 0, 0) };
        noticeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        noticeRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        noticeRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        noticeRow.Controls.Add(_notice, 0, 0);
        noticeRow.Controls.Add(_earlier, 1, 0);

        Buttons(_startRow, BarLayout.Space, _startApp, _useOpen);
        _startRow.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _readyText.Margin = new Padding(0, BarLayout.Group, 0, 0);
        Buttons(_recordRow, BarLayout.Space, _pause, _finish);
        _recordRow.Margin = new Padding(0, BarLayout.Space, 0, 0);
        // Named here: WinForms otherwise names an unnamed control after a label before it (the values page's hidden intro).
        _list.AccessibleName = BarText.ListName;
        _valuesArea.AccessibleName = ValuesPage.AreaName;
        _actionRow.AccessibleName = BarText.StepActionsName;
        _listArea.Controls.Add(_list);
        _listArea.Controls.Add(_empty);
        _empty.BringToFront();
        _readHint.Margin = new Padding(0, BarLayout.Tight, 0, 0);

        // The step actions are two rows of the bar's own table, not a table of their own: a table inside a table is
        // measured at the width of its widest label, where the buttons wrapped into three rows, and the bar kept those
        // rows' height as an empty band under them. They never wrap: 4 apart, they fit a bar 360 wide.
        Buttons(_actionRow, BarLayout.Tight, _delete, _secret);
        _actionRow.WrapContents = false;
        _actionHint.Margin = new Padding(0, BarLayout.Space, 0, 0);

        _valuesIntro.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _valuesTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _valuesTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _valuesTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        _valuesArea.Controls.Add(_valuesTable);
        _listArea.Controls.Add(_valuesArea);
        _valuesProblem.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        _valuesButtons.FlowDirection = FlowDirection.RightToLeft;
        _valuesButtons.WrapContents = false;
        _valuesButtons.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _continue.Margin = _back.Margin = new Padding(BarLayout.Space, 0, 0, BarLayout.Tight);
        // Right to left: Continue at the right edge, Back to its left.
        _valuesButtons.Controls.AddRange([_continue, _back]);

        var nameLabel = Wrap(BarText.Name);
        nameLabel.Margin = new Padding(0, BarLayout.Group, 0, BarLayout.Tight);
        var folderRow = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Fill, Margin = Padding.Empty };
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _folderLine.Anchor = AnchorStyles.Left;
        _changeFolder.Anchor = AnchorStyles.Right;
        folderRow.Controls.Add(_folderLine, 0, 0);
        folderRow.Controls.Add(_changeFolder, 1, 0);
        // Right to left, as the values page's buttons: Save at the right edge, Back to its left.
        var saveRow = Row();
        saveRow.FlowDirection = FlowDirection.RightToLeft;
        saveRow.WrapContents = false;
        saveRow.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _save.Margin = _finishedBack.Margin = new Padding(BarLayout.Space, 0, 0, 0);
        saveRow.Controls.AddRange([_save, _finishedBack]);
        _saveBlock.Controls.AddRange([nameLabel, _name, folderRow, saveRow]);

        _allowTitle.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _importTitle.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _allowButton.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        // Show the file, Open the import form and, once an address is kept, Change address…: one row that wraps on a narrow bar.
        Buttons(_importRow, BarLayout.Space, _showFile, _openForm);
        _importRow.Controls.Add(_changeAddress);
        _importRow.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        _recordAnother.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _recordAnother.Anchor = AnchorStyles.Right;
        _nextBlock.Controls.AddRange([_allowTitle, _allowDetail, _allowCommand, _allowButton, _importTitle, _importDetail, _importRow, _recordAnother]);

        Control[] rows = [header, _guidance, noticeRow, _startRow, _readyText, _recordRow, _valuesIntro, _listArea, _readHint, _actionHint, _actionRow, _valuesProblem, _valuesButtons, _saveBlock, _nextBlock];
        // Each part in its own row, by number. Added without a position, a part goes into the next free cell, and a
        // TableLayoutPanel gives a hidden control no cell: the parts after a hidden one moved up into the row styles
        // of others, and the list lost its 100 % row while recording. A part at a fixed row keeps it; a hidden part's
        // AutoSize row is then simply 0 high.
        _layout.RowCount = rows.Length;
        for (var i = 0; i < rows.Length; i++)
        {
            // The list takes the height that is left; the notice line has a fixed height (FitSizes), so that a notice
            // never moves the list.
            _layout.RowStyles.Add(rows[i] == _listArea ? new RowStyle(SizeType.Percent, 100) : rows[i] == noticeRow ? new RowStyle(SizeType.Absolute, 24) : new RowStyle(SizeType.AutoSize));
            _layout.Controls.Add(rows[i], 0, i);
        }
        _guidance.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        Controls.Add(_layout);
    }

    private static TableLayoutPanel Column(bool fill = false)
    {
        // GrowAndShrink: a TableLayoutPanel that sizes itself keeps the largest size it ever had by default (GrowOnly),
        // which left empty space under the step buttons once they stopped wrapping.
        var column = new TableLayoutPanel { ColumnCount = 1, Dock = DockStyle.Fill, Margin = Padding.Empty, AutoSize = !fill, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        column.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return column;
    }

    private static FlowLayoutPanel Row() => new() { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Dock = DockStyle.Fill, Margin = Padding.Empty };

    /// <summary>A row of buttons, the first at the left edge and the others <paramref name="gap"/> apart.</summary>
    private static void Buttons(FlowLayoutPanel row, int gap, params Button[] buttons)
    {
        for (var i = 0; i < buttons.Length; i++) buttons[i].Margin = new Padding(i == 0 ? 0 : gap, 0, 0, BarLayout.Tight);
        row.Controls.AddRange(buttons);
    }

    private string ReadyText() => string.Join(Environment.NewLine + Environment.NewLine, BarText.ReadySentences(_narrow));

    private Label Wrap(string text = "", bool quiet = false)
    {
        var label = SmallDialog.NewLabel(text, quiet);
        label.MaximumSize = Size.Empty;
        label.Margin = Padding.Empty;
        _wrapping.Add(label);
        return label;
    }

    /// <summary>Labels wrap at the bar's width; the notice line is one line high. Both follow the window's size and
    /// the screen's scaling.</summary>
    private void FitSizes()
    {
        var width = _layout.ClientSize.Width;
        foreach (var label in _wrapping)
        {
            var max = new Size(Math.Max(1, width - label.Margin.Horizontal - (label.Parent is TableLayoutPanel { ColumnCount: 2 } ? _changeFolder.Width + _changeFolder.Margin.Horizontal : 0)), 0);
            if (label.MaximumSize != max) label.MaximumSize = max;
        }
        // One line: a longer notice is cut with an ellipsis, and reads whole in its tooltip and in Earlier notices.
        var noticeHeight = _notice.Font.Height + LogicalToDeviceUnits(BarLayout.Tight);
        var style = _layout.RowStyles[2];
        if ((int)style.Height != noticeHeight) style.Height = noticeHeight;
        FitValues();
    }

    /// <summary>The values page's sentences wrap in its third column: what is left of the page's width after the tick
    /// boxes and the numbers (both columns size to their contents, so they do not depend on it). The table lies docked
    /// to the top of a scrolling panel, which hands it its width without the scroll bar.</summary>
    private void FitValues()
    {
        if (_valueTexts.Count == 0) return;
        var widths = _valuesTable.GetColumnWidths();
        if (widths.Length < 3) return;
        var width = _valuesArea.ClientSize.Width - _valuesArea.Padding.Horizontal - widths[0] - widths[1];
        foreach (var label in _valueTexts)
        {
            var max = new Size(Math.Max(1, width - label.Margin.Horizontal), 0);
            if (label.MaximumSize != max) label.MaximumSize = max;
        }
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        BeginInvoke(FitSizes);
    }

    // ---- What the bar shows ----

    private void ShowStage(BarStage stage)
    {
        _stage = stage;
        _log.Stage(stage);
        var parts = BarText.Parts(stage, _list.SelectedIndex >= 0);
        _dot.ForeColor = BarText.Color(stage) switch { BarColor.Recording => Red, BarColor.Paused => Amber, _ => SystemColors.GrayText };
        _state.Text = BarText.StateLine(stage, _starting ?? _capture.ProgramPath, _shown.Count);
        _guidance.Text = stage == BarStage.Saved
            ? BarText.Guidance(stage, Path.GetFileName(_savedRecording), SaveNames.FolderShown(_folder, _documents))
            : BarText.Guidance(stage);
        _startRow.Visible = parts.HasFlag(BarPart.StartButtons);
        _readyText.Visible = parts.HasFlag(BarPart.ReadyText);
        _recordRow.Visible = parts.HasFlag(BarPart.RecordButtons);
        _readHint.Visible = parts.HasFlag(BarPart.ReadHint);
        _actionHint.Visible = _actionRow.Visible = parts.HasFlag(BarPart.StepActions);
        // The values page takes the list's place (its row is the one that gets the height that is left).
        var values = parts.HasFlag(BarPart.ValuesPage);
        _listArea.Visible = parts.HasFlag(BarPart.List) || values;
        _listArea.AccessibleName = BarText.ListAreaName(parts);
        _list.Visible = parts.HasFlag(BarPart.List);
        // From the parts, not _list.Visible: before the bar is first shown, Visible reads false for every control in it.
        _empty.Visible = BarText.ShowsEmptyList(parts, _shown.Count);
        _valuesArea.Visible = _valuesIntro.Visible = _valuesButtons.Visible = values;
        _valuesProblem.Visible = values && _valuesProblem.Text.Length > 0;
        _saveBlock.Visible = parts.HasFlag(BarPart.SaveBlock);
        _finishedBack.Visible = stage == BarStage.Finished && BarText.Back(stage, _ended, _shown) is not null;
        _nextBlock.Visible = parts.HasFlag(BarPart.NextSteps);
        _pause.Text = BarText.PauseButton(stage);
        _folderLine.Text = SaveNames.FolderLine(SaveNames.FolderShown(_folder, _documents));

        NextLine? allow = null;
        if (stage == BarStage.Saved && _savedChange is not null)
        {
            allow = NextSteps.Allow(BarText.AppName(_capture.ProgramPath), _policyTool, _savedChange, _allow);
            _allowTitle.Text = allow.Title;
            _allowDetail.Text = allow.Detail;
            _allowCommand.Text = allow.Command ?? "";
            _allowCommand.Visible = allow.Command is not null;
            _allowButton.Visible = allow.Button is not null;
            _allowButton.Enabled = allow.ButtonEnabled;
            var import = NextSteps.Import(_formOpened);
            _importTitle.Text = import.Title;
            _importDetail.Text = import.Detail;
            _changeAddress.Visible = _form is not null;
        }
        AcceptButton = BarText.Primary(stage, allow) switch
        {
            BarText.StartApp => _startApp,
            BarText.Save => _save,
            ValuesPage.Continue => _continue,
            NextSteps.AllowButton => _allowButton,
            NextSteps.ShowFile => _showFile,
            _ => null,
        };
        ShowActions();
        KeepListRows(stage, parts);
    }

    /// <summary>
    /// When the stage or its parts change, the bar grows (<see cref="BarLayout.GrowForList"/>: down to the bottom of the
    /// working area, then up) so that the list shows <see cref="BarText.MinListRows"/> rows as high as they are
    /// (<see cref="StepRows.ListHeight"/>), or the values page its rows. It does not grow again for every new step, so
    /// a bar the person made smaller stays so while recording, and it never shrinks by itself. The list's row (or the
    /// page's) is the table's only Percent row: whatever the bar grows by goes to it.
    /// </summary>
    private void KeepListRows(BarStage stage, BarPart parts)
    {
        var rows = BarText.MinListRows(stage);
        var values = parts.HasFlag(BarPart.ValuesPage);
        if ((rows == 0 && !values) || !IsHandleCreated || _grownFor == (stage, parts)) return;
        _grownFor = (stage, parts);
        _layout.PerformLayout();
        int now, needed;
        if (values)
        {
            FitValues();
            _valuesArea.PerformLayout();
            now = _valuesArea.Height;
            needed = _valuesTable.Height + _valuesArea.Padding.Vertical + (_valuesArea.Height - _valuesArea.ClientSize.Height);
        }
        else
        {
            now = _list.Height;
            needed = StepRows.ListHeight(_list.RowHeights, rows, _list.RowHeight) + (_list.Height - _list.ClientSize.Height);
        }
        var grown = BarLayout.GrowForList(Bounds, now, needed, Screen.FromControl(this).WorkingArea);
        if (grown != Bounds) Bounds = grown;
    }

    private void ShowActions()
    {
        var i = _list.SelectedIndex;
        var actions = StepRows.ActionsFor(i >= 0 && i < _shown.Count ? _shown[i] : null, i + 1);
        _delete.Enabled = actions.Delete;
        _secret.Enabled = actions.Secret;
        _actionHint.Text = actions.Hint;
    }

    /// <summary>The steps changed (or the recording started, paused or stopped): the list, the count, and whether the
    /// saved files still hold what the list shows.</summary>
    private void StepsChanged()
    {
        var steps = _capture.Steps();
        var now = steps.Select(s => s.Step).ToArray();
        var follow = StepRows.NewestChanged(_shown, now);
        _shown = now;
        _list.ShowRows(StepRows.Of(steps, _capture.Seen), follow);
        ShowStage(_stage == BarStage.Saved && StepRows.Unsaved(_saved, _shown) ? BarStage.Finished : _stage);
    }

    private void Say(DateTimeOffset at, string text, NoticeTone tone)
    {
        _notices.Add(new BarNotice(at, text, tone));
        var current = _notices.Current!;
        _notice.Text = current.Text;
        _notice.ForeColor = current.Tone == NoticeTone.Check ? Amber : SystemColors.WindowText;
        _tip.SetToolTip(_notice, current.Text);
        _earlier.Text = _notices.EarlierLink ?? "";
        _earlier.Visible = _notices.EarlierLink is not null;
    }

    private void Say(string text, NoticeTone tone = NoticeTone.Check) => Say(DateTimeOffset.Now, text, tone);

    private void ClearNotices()
    {
        _notices.Clear();
        _notice.Text = "";
        _tip.SetToolTip(_notice, "");
        _earlier.Visible = false;
    }

    // ---- Recording ----

    private Capture NewCapture()
    {
        var capture = new Capture(readKey: true);
        capture.Changed += () => Post(capture, StepsChanged);
        capture.Noticed += n => Post(capture, () => Say(n.At, n.Text, NoticeLine.Tone(n.Kind)));
        capture.ReadRequested += (element, window) => Post(capture, () => AskRead(element, window));
        return capture;
    }

    /// <summary>Runs on the bar's thread what a capture reports from its own threads, unless the bar has moved on to a
    /// new recording or is closing.</summary>
    private void Post(Capture from, Action action)
    {
        if (!IsHandleCreated || IsDisposed) return;
        try { BeginInvoke(() => { if (ReferenceEquals(from, _capture)) action(); }); }
        catch (InvalidOperationException) { } // the bar is closing
    }

    private async Task StartApp()
    {
        using var dialog = new StartDialog(this);
        if (!Ask(dialog)) return;
        _starting = dialog.Program;
        ShowStage(BarStage.Starting);
        var started = false;
        try { started = await Task.Run(() => _capture.Launch(dialog.Program, dialog.Arguments)); }
        catch (ArgumentException e) { if (!IsDisposed) Say(Notices.DidNotStart(e.Message)); }
        if (IsDisposed) return;
        _starting = null;
        ShowStage(started ? BarStage.Recording : BarStage.Ready);
    }

    private void UseOpenApp()
    {
        var own = (uint)Environment.ProcessId;
        var windows = Native.TopLevelWindows()
            .Where(h => OpenWindows.IsOffered(Native.TitleOf(h), Native.ClassOf(h), Native.IsCloaked(h), Native.ProcessOf(h) == own))
            .Select(h => (Handle: h, Text: DialogText.WindowEntry(Native.TitleOf(h), UiaWorker.ExeOf(Native.ProcessOf(h)))))
            .ToList();
        using var dialog = new OpenAppDialog(this, windows.Select(w => w.Text).ToArray());
        if (!Ask(dialog) || dialog.Choice < 0) return;
        if (!_capture.Attach(windows[dialog.Choice].Handle)) return;
        ShowStage(BarStage.Recording);
        _capture.GiveFocusBack();
    }

    private void TogglePause()
    {
        _capture.Pause(_capture.Recording);
        ShowStage(_capture.Recording ? BarStage.Recording : BarStage.Paused);
        BackToApp();
    }

    /// <summary>
    /// Finish: when a step typed a value or chose an item, the values page, with the recording paused (Back returns to
    /// the list, Resume goes on recording); otherwise the name and Save at once. Pausing reads the field being typed
    /// into first, so the page has every value.
    /// </summary>
    private void Finish()
    {
        if (_capture.Recording) _capture.Pause(true);
        var steps = _capture.Steps().Select(s => s.Step).ToArray();
        if (BarText.AfterFinish(steps) == BarStage.Finished)
        {
            EndRecording();
            return;
        }
        OpenValues();
    }

    /// <summary>The values page for the steps as they are now, with the choices made before Back.</summary>
    private void OpenValues()
    {
        ShowValues(ValuesPage.Rows(_capture.Steps().Select(s => s.Step).ToArray(), _valueRows, _capture.StartValue));
        ShowStage(BarStage.Values);
        var first = _valuesTable.Controls.OfType<CheckBox>().FirstOrDefault(c => c.Enabled);
        if (first is not null) first.Focus();
        else _continue.Focus();
    }

    /// <summary>Continue on the values page: each ticked value becomes a variable (ValuesPage.Apply), then the name and Save.</summary>
    private void ContinueFromValues()
    {
        if (_valueRows is not { } rows || ValuesPage.Problem(rows) is not null) return;
        try { _capture.Use(s => { ValuesPage.Apply(s, rows); return 0; }); }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException) { Say(e.Message); }
        _valueRows = null;
        EndRecording();
    }

    /// <summary>Back (<see cref="BarText.Back"/>): from the values page to the list, paused, or to Finished once the
    /// recording has ended; from Finished to the values page.</summary>
    private void GoBack()
    {
        if (BarText.Back(_stage, _ended, _shown) is not { } to) return;
        if (to == BarStage.Values) OpenValues();
        else ShowStage(to);
    }

    private void EndRecording()
    {
        if (!_ended) _capture.Stop();
        _ended = true;
        // A step selected while recording would stay selected, and Finished and Saved would open with the step actions.
        _list.ClearSelected();
        if (_name.Text.Trim().Length == 0) _name.Text = SaveNames.SuggestedName(_capture.ProgramPath);
        ShowStage(BarStage.Finished);
        _name.Focus();
        _name.SelectAll();
    }

    /// <summary>
    /// The values page's rows: a tick box, the step's number and its sentence as the list says it, and under it the
    /// variable's name (a secret: the line that says where its value comes from). The controls are made after the
    /// window was scaled for the screen, so their spacing is given in the screen's pixels; their font is the bar's.
    /// </summary>
    private void ShowValues(IReadOnlyList<ValueRow> rows)
    {
        _valueRows = rows.ToArray();
        _valuesTable.SuspendLayout();
        foreach (var old in _valuesTable.Controls.Cast<Control>().ToArray()) old.Dispose();
        _valueTexts.Clear();
        _valuesTable.RowStyles.Clear();
        // Three table rows a value: its sentence, the grey start line of a variable (empty, so 0 high, without one), and
        // its name box or secret note.
        _valuesTable.RowCount = rows.Count * 3;
        int D(int logical) => LogicalToDeviceUnits(logical);
        for (var i = 0; i < rows.Count; i++)
        {
            var at = i;
            var row = rows[i];
            var top = i == 0 ? 0 : D(BarLayout.Tight);
            var tick = new CheckBox { AutoSize = true, Checked = row.Ticked, Enabled = row.CanUntick, AccessibleName = $"{row.Number}. {row.Text}", Margin = new Padding(0, top + D(2), D(BarLayout.Tight), 0) };
            var number = new Label
            {
                AutoSize = true, Text = row.Number.ToString(System.Globalization.CultureInfo.InvariantCulture), UseMnemonic = false,
                ForeColor = SystemColors.GrayText, Anchor = AnchorStyles.Top | AnchorStyles.Right, Margin = new Padding(0, top, D(BarLayout.Space), 0),
            };
            var text = new Label { AutoSize = true, Text = row.Text, UseMnemonic = false, Margin = new Padding(0, top, 0, 0) };
            text.Click += (_, _) => { if (tick.Enabled) tick.Checked = !tick.Checked; };
            _valueTexts.Add(text);
            if (ValuesPage.Tip(row) is { } why)
            {
                // A disabled tick box shows no tooltip: the sentence carries it too.
                _tip.SetToolTip(tick, why);
                _tip.SetToolTip(text, why);
            }
            Control under;
            if (row.Kind == ValueKind.Secret)
            {
                var note = new Label { AutoSize = true, Text = ValuesPage.SecretNote(row), UseMnemonic = false, ForeColor = SystemColors.GrayText, Margin = new Padding(0, D(BarLayout.Tight), 0, D(BarLayout.Space)) };
                _valueTexts.Add(note);
                under = note;
            }
            else
            {
                var name = new TextBox
                {
                    Text = row.Name, Dock = DockStyle.Fill, Enabled = row.NameEditable, PlaceholderText = ValuesPage.NameLabel,
                    AccessibleName = $"{ValuesPage.NameLabel}, step {row.Number}", Margin = new Padding(0, D(BarLayout.Tight), 0, D(BarLayout.Space)),
                };
                _tip.SetToolTip(name, ValuesPage.NameLabel);
                name.TextChanged += (_, _) =>
                {
                    if (_valueRows is not { } now) return;
                    now[at] = now[at].WithName(name.Text);
                    CheckValues();
                };
                tick.CheckedChanged += (_, _) =>
                {
                    if (_valueRows is not { } now) return;
                    now[at] = now[at].WithTick(tick.Checked);
                    name.Enabled = now[at].NameEditable;
                    CheckValues();
                };
                under = name;
            }
            for (var r = 0; r < 3; r++) _valuesTable.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _valuesTable.Controls.Add(tick, 0, 3 * i);
            _valuesTable.Controls.Add(number, 1, 3 * i);
            _valuesTable.Controls.Add(text, 2, 3 * i);
            if (ValuesPage.StartsAs(row) is { } startsAs)
            {
                var start = new Label { AutoSize = true, Text = startsAs, UseMnemonic = false, ForeColor = SystemColors.GrayText, Margin = new Padding(0, D(BarLayout.Tight), 0, 0) };
                _valueTexts.Add(start);
                _valuesTable.Controls.Add(start, 2, 3 * i + 1);
            }
            _valuesTable.Controls.Add(under, 2, 3 * i + 2);
        }
        _valuesTable.ResumeLayout();
        _valuesArea.AutoScrollPosition = Point.Empty;
        CheckValues();
    }

    /// <summary>A ticked value's name is checked as it is typed: the problem shows above the buttons, and Continue waits.</summary>
    private void CheckValues()
    {
        if (_valueRows is null) return;
        var problem = ValuesPage.Problem(_valueRows);
        _valuesProblem.Text = problem ?? "";
        _valuesProblem.Visible = _stage == BarStage.Values && problem is not null;
        _continue.Enabled = problem is null;
    }

    private void Delete()
    {
        var i = _list.SelectedIndex;
        if (i >= 0) _capture.Use(s => { s.Delete(i); return 0; });
        BackToApp();
    }

    private void MakeSecret()
    {
        var i = _list.SelectedIndex;
        if (i < 0 || i >= _shown.Count) return;
        using var dialog = new NameDialog(this, DialogText.Secret(i + 1, _shown[i]), []);
        if (Ask(dialog))
        {
            var name = dialog.Answer;
            try { _capture.Use(s => { s.MarkSecret(i, name); return 0; }); }
            catch (Exception e) when (e is ArgumentException or InvalidOperationException) { Say(e.Message); }
        }
        BackToApp();
    }

    /// <summary>F9 over an element in the app: the question names it as the person sees it; the answer adds the read.</summary>
    private void AskRead(ElementFacts element, WindowFacts window)
    {
        if (_asking) return;
        var taken = _shown.Where(s => s.Kind == StepKind.Read && s.As is not null).Select(s => s.As!).ToArray();
        using var dialog = new NameDialog(this, DialogText.Read(_shown.Count + 1, element), taken);
        if (Ask(dialog))
        {
            try { _capture.AddRead(element, window, dialog.Answer); }
            catch (ArgumentException e) { Say(e.Message); }
        }
        BackToApp();
    }

    /// <summary>After a bar action while recording, the app gets the activation back: the person's next click there acts,
    /// instead of only activating the app's window (which would be recorded as a click).</summary>
    private void BackToApp()
    {
        if (_stage is BarStage.Recording or BarStage.Paused) _capture.GiveFocusBack();
    }

    // ---- Saving and what comes after ----

    private void ChangeFolder()
    {
        using var pick = new FolderBrowserDialog
        {
            Description = DialogText.FolderTitle, UseDescriptionForTitle = true, ShowNewFolderButton = true,
            InitialDirectory = Directory.Exists(_folder) ? _folder : _documents,
        };
        if (pick.ShowDialog(this) != DialogResult.OK) return;
        _folder = pick.SelectedPath;
        ShowStage(_stage);
    }

    /// <summary>Saves into the folder (created when missing). Nothing is replaced without asking.</summary>
    private void Save()
    {
        var name = _name.Text.Trim();
        if (name.Length == 0)
        {
            Say(SaveNames.NameMissing);
            _name.Focus();
            return;
        }
        var shown = SaveNames.FolderShown(_folder, _documents);
        try { Directory.CreateDirectory(_folder); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            Say(SaveNames.NotSaved($"the folder {shown} could not be created ({e.Message.TrimEnd('.')})."));
            return;
        }
        var existing = new[] { SaveNames.Recording(name), SaveNames.PolicyChange(name) }.Where(f => File.Exists(Path.Combine(_folder, f))).ToArray();
        if (existing.Length > 0 && !Confirm(DialogText.Replace(shown, existing))) return;
        try
        {
            var saved = _shown;
            (_savedRecording, _savedChange) = _capture.Save(_folder, name, overwrite: existing.Length > 0);
            _saved = saved;
            _allow = AllowState.NotDone;
            _formOpened = null;
            ShowStage(BarStage.Saved);
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            Say(SaveNames.NotSaved(e.Message));
        }
    }

    /// <summary>
    /// Starts the install's policy tool on the saved change file, as administrator (Windows asks), in a window of its
    /// own where it shows what it allows and asks. The bar waits for it and says what its exit code means; the
    /// recorder itself changes no policy.
    /// </summary>
    private async Task Allow()
    {
        if (_policyTool is not { } tool || _savedChange is not { } change) return;
        _allow = AllowState.Waiting;
        ShowStage(_stage);
        var (exit, error) = await Task.Run(() => RunPolicyTool(tool, change));
        // The bar closed, or moved on to another recording (Record another) while the tool was open: its answer is
        // about a file the bar no longer shows.
        if (IsDisposed || _savedChange != change) return;
        _allow = AllowState.NotDone;
        if (exit is { } code)
        {
            var outcome = NextSteps.Outcome(code);
            if (outcome.Allowed) _allow = AllowState.Allowed;
            if (outcome.Notice is { } text) Say(text, outcome.Tone);
        }
        else if (error is null) Say(NextSteps.Cancelled, NoticeTone.Information);
        else Say(NextSteps.NotStarted(error));
        ShowStage(_stage);
    }

    /// <summary>The policy tool's exit code; or no code and no error when the person cancelled Windows' administrator
    /// prompt; or the reason it did not start.</summary>
    private static (int? Exit, string? Error) RunPolicyTool(string tool, string change)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(tool)
            {
                UseShellExecute = true, Verb = "runas", Arguments = NextSteps.StartArguments(change), WorkingDirectory = Path.GetDirectoryName(tool)!,
            });
            if (process is null) return (null, "Windows gave no process.");
            process.WaitForExit();
            return (process.ExitCode, null);
        }
        catch (Win32Exception e) when (e.NativeErrorCode == 1223) // ERROR_CANCELLED: the prompt was declined
        {
            return (null, null);
        }
        catch (Win32Exception e)
        {
            return (null, e.Message);
        }
    }

    /// <summary>Opens the folder with the recording file selected (Explorer from the Windows folder, not from the path).</summary>
    private void ShowFile()
    {
        if (_savedRecording is null) return;
        try
        {
            Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), NextSteps.ExplorerSelect(_savedRecording)))?.Dispose();
        }
        catch (Win32Exception e) { Say(e.Message); }
    }

    /// <summary>
    /// Open the import form: the recording's full path goes on the clipboard, and the default browser opens the kept
    /// address (asked for the first time). The recorder uploads nothing and holds no login. It opens only the
    /// normalised address of <see cref="ImportForm.Check"/>, never the box's text, and the bar log names only the button.
    /// </summary>
    private void OpenImportForm()
    {
        if (_savedRecording is not { } recording) return;
        if ((_form ?? AskAddress("")) is not { Verdict: not AddressVerdict.Refused, Target: { } target }) return;
        var copied = CopyPath(recording);
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })?.Dispose(); }
        catch (Win32Exception e)
        {
            _formOpened = null;
            ShowStage(_stage);
            Say(NextSteps.BrowserNotStarted(e.Message));
            return;
        }
        _formOpened = new FormOpened(copied, Path.GetFileName(recording), SaveNames.FolderShown(Path.GetDirectoryName(recording)!, _documents));
        ShowStage(_stage);
    }

    /// <summary>Asks for the import form's address (filled in with <paramref name="filled"/>), and for an http address
    /// that leaves this machine and its network, whether to continue (Back returns to the address). Keeps the answer.</summary>
    private FormAddress? AskAddress(string filled)
    {
        while (true)
        {
            FormAddress address;
            using (var dialog = new AddressDialog(this, filled))
            {
                if (!Ask(dialog)) return null;
                address = dialog.Address;
                filled = dialog.Typed;
            }
            if (address.Verdict == AddressVerdict.Refused) return null;
            if (address.Verdict == AddressVerdict.AskFirst && !Confirm(DialogText.PlainHttp)) continue;
            ImportForm.Keep(_formPath, address);
            _form = address;
            if (_stage == BarStage.Saved) ShowStage(_stage);
            return address;
        }
    }

    /// <summary>Puts the path on the clipboard; false when the clipboard is held by another program and stays so.</summary>
    private static bool CopyPath(string path)
    {
        try
        {
            Clipboard.SetDataObject(path, copy: true, retryTimes: 5, retryDelay: 100);
            return true;
        }
        catch (ExternalException) { return false; }
    }

    /// <summary>
    /// Starts over with a new recording, after asking when the steps are not saved. The question takes the foreground
    /// when it opens (SmallDialog), also when another program had it; without a question the bar goes to Ready at once.
    /// The stage is Ready before the list is emptied, so the list's selection change does not show Saved again on the
    /// way; the old capture (its UI Automation thread) ends off the bar's thread.
    /// </summary>
    private void RecordAnother()
    {
        if (StepRows.Unsaved(_saved, _shown) && !Confirm(DialogText.StartOverUnsaved(_shown.Count))) return;
        _stage = BarStage.Ready;
        _grownFor = null;
        var old = _capture;
        _capture = NewCapture();
        Task.Run(old.Dispose);
        _shown = [];
        _saved = null;
        _savedRecording = _savedChange = null;
        _valueRows = null;
        _ended = false;
        _allow = AllowState.NotDone;
        _formOpened = null;
        _name.Text = "";
        _list.ShowRows([], followNewest: false);
        ClearNotices();
        ShowStage(BarStage.Ready);
    }

    private void ShowEarlierNotices()
    {
        using var dialog = new NoticesDialog(this, _notices.All);
        Ask(dialog);
        BackToApp();
    }

    // ---- Questions ----

    private bool Confirm(Question question)
    {
        using var dialog = new QuestionDialog(this, question);
        return Ask(dialog);
    }

    /// <summary>Shows one of the bar's windows; true when the person chose its action. One at a time: an F9 while one
    /// is open is ignored.</summary>
    private bool Ask(Form dialog)
    {
        _asking = true;
        try { return dialog.ShowDialog(this) == DialogResult.OK; }
        finally { _asking = false; }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _tip.Dispose();
        base.Dispose(disposing);
    }
}
