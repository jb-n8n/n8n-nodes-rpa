using System.ComponentModel;
using System.Diagnostics;
using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// The recorder's bar: a window that stays on top at the top right of the screen. At the top, the state in words with
/// a coloured dot (red while recording, amber while paused), one sentence that says what to do now, and the notice
/// line. Below, what the stage needs: Ready offers two ways to choose the app; Recording and Paused show Pause or
/// Resume, Finish, the numbered steps and the step actions; Finished adds the name and Save; after saving, what to do
/// next (allow the app with the policy tool, import the recording in n8n) and Record another. Everything the bar
/// decides or says is in Rpa.Recorder.Core (BarText, StepRows, DialogText, NoticeLine, SaveNames, NextSteps,
/// BarLayout); this class shows it. The bar's own windows are never recorded, and after a bar action while recording
/// the app gets the focus back.
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
    private Capture _capture;
    private BarStage _stage = BarStage.Ready;
    private string? _starting;
    private string _folder;
    private IReadOnlyList<RecordedStep> _shown = [];
    private IReadOnlyList<RecordedStep>? _saved;
    private string? _savedRecording, _savedChange;
    private AllowState _allow = AllowState.NotDone;
    private bool _asking;

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
    private readonly TableLayoutPanel _actions = Column();
    private readonly Label _actionHint;
    private readonly Button _delete = SmallDialog.NewButton(BarText.DeleteStep);
    private readonly Button _variable = SmallDialog.NewButton(BarText.MakeVariable);
    private readonly Button _secret = SmallDialog.NewButton(BarText.MakeSecret);
    private readonly TableLayoutPanel _saveBlock = Column();
    private readonly TextBox _name = new() { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
    private readonly Label _folderLine;
    private readonly Button _changeFolder = SmallDialog.NewButton(BarText.ChangeFolder);
    private readonly Button _save = SmallDialog.NewButton(BarText.Save);
    private readonly TableLayoutPanel _nextBlock = Column();
    private readonly Label _allowTitle, _allowDetail, _importTitle, _importDetail;
    private readonly TextBox _allowCommand = new() { ReadOnly = true, Dock = DockStyle.Fill, BackColor = SystemColors.Window, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
    private readonly Button _allowButton = SmallDialog.NewButton(NextSteps.AllowButton);
    private readonly Button _showFile = SmallDialog.NewButton(NextSteps.ShowFile);
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

        _guidance = Wrap();
        _readyText = Wrap(string.Join(Environment.NewLine + Environment.NewLine, BarText.ReadySentences));
        _readHint = Wrap(BarText.ReadHint, quiet: true);
        _actionHint = Wrap(quiet: true);
        _folderLine = Wrap(quiet: true);
        _allowTitle = Wrap();
        _allowDetail = Wrap(quiet: true);
        _importTitle = Wrap(NextSteps.Import.Title);
        _importDetail = Wrap(NextSteps.Import.Detail, quiet: true);
        Build();
        _capture = NewCapture();

        _startApp.Click += async (_, _) => await StartApp();
        _useOpen.Click += (_, _) => UseOpenApp();
        _pause.Click += (_, _) => TogglePause();
        _finish.Click += (_, _) => Finish();
        _list.SelectedIndexChanged += (_, _) => ShowActions();
        _delete.Click += (_, _) => Delete();
        _variable.Click += (_, _) => Mark(secret: false);
        _secret.Click += (_, _) => Mark(secret: true);
        _changeFolder.Click += (_, _) => ChangeFolder();
        _save.Click += (_, _) => Save();
        _allowButton.Click += async (_, _) => await Allow();
        _showFile.Click += (_, _) => ShowFile();
        _recordAnother.Click += (_, _) => RecordAnother();
        _earlier.LinkClicked += (_, _) => ShowEarlierNotices();
        _layout.SizeChanged += (_, _) => FitSizes();

        Load += (_, _) =>
        {
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
            Bounds = BarLayout.Initial(area, Size, LogicalToDeviceUnits(BarLayout.Space));
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

        _startRow.Controls.AddRange([_startApp, _useOpen]);
        _startRow.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _readyText.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _recordRow.Controls.AddRange([_pause, _finish]);
        _recordRow.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _listArea.Controls.Add(_list);
        _listArea.Controls.Add(_empty);
        _empty.BringToFront();
        _readHint.Margin = new Padding(0, BarLayout.Tight, 0, 0);

        var actionRow = Row();
        actionRow.Controls.AddRange([_delete, _variable, _secret]);
        _actionHint.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _actions.Controls.Add(_actionHint);
        _actions.Controls.Add(actionRow);

        var nameLabel = Wrap(BarText.Name);
        nameLabel.Margin = new Padding(0, BarLayout.Group, 0, BarLayout.Tight);
        var folderRow = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill, Margin = Padding.Empty };
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _folderLine.Anchor = AnchorStyles.Left;
        _changeFolder.Anchor = AnchorStyles.Right;
        folderRow.Controls.Add(_folderLine, 0, 0);
        folderRow.Controls.Add(_changeFolder, 1, 0);
        _save.Anchor = AnchorStyles.Right;
        _save.Margin = new Padding(0, BarLayout.Space, 0, 0);
        _saveBlock.Controls.AddRange([nameLabel, _name, folderRow, _save]);

        _allowTitle.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _importTitle.Margin = new Padding(0, BarLayout.Group, 0, 0);
        foreach (var b in new[] { _allowButton, _showFile, _recordAnother }) b.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        _recordAnother.Margin = new Padding(0, BarLayout.Group, 0, 0);
        _recordAnother.Anchor = AnchorStyles.Right;
        _nextBlock.Controls.AddRange([_allowTitle, _allowDetail, _allowCommand, _allowButton, _importTitle, _importDetail, _showFile, _recordAnother]);

        Control[] rows = [header, _guidance, noticeRow, _startRow, _readyText, _recordRow, _listArea, _readHint, _actions, _saveBlock, _nextBlock];
        foreach (var row in rows)
        {
            // The list takes the height that is left; the notice line has a fixed height (FitSizes), so that a notice
            // never moves the list.
            _layout.RowStyles.Add(row == _listArea ? new RowStyle(SizeType.Percent, 100) : row == noticeRow ? new RowStyle(SizeType.Absolute, 40) : new RowStyle(SizeType.AutoSize));
            _layout.Controls.Add(row);
        }
        _guidance.Margin = new Padding(0, BarLayout.Tight, 0, 0);
        Controls.Add(_layout);
    }

    private static TableLayoutPanel Column(bool fill = false)
    {
        var column = new TableLayoutPanel { ColumnCount = 1, Dock = DockStyle.Fill, Margin = Padding.Empty, AutoSize = !fill };
        column.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return column;
    }

    private static FlowLayoutPanel Row() => new() { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Dock = DockStyle.Fill, Margin = Padding.Empty };

    private Label Wrap(string text = "", bool quiet = false)
    {
        var label = SmallDialog.NewLabel(text, quiet);
        label.MaximumSize = Size.Empty;
        label.Margin = Padding.Empty;
        _wrapping.Add(label);
        return label;
    }

    /// <summary>Labels wrap at the bar's width; the notice line is two lines high. Both follow the window's size and
    /// the screen's scaling.</summary>
    private void FitSizes()
    {
        var width = _layout.ClientSize.Width;
        foreach (var label in _wrapping)
        {
            var max = new Size(Math.Max(1, width - label.Margin.Horizontal - (label.Parent is TableLayoutPanel { ColumnCount: 2 } ? _changeFolder.Width + _changeFolder.Margin.Horizontal : 0)), 0);
            if (label.MaximumSize != max) label.MaximumSize = max;
        }
        var noticeHeight = 2 * _notice.Font.Height + LogicalToDeviceUnits(BarLayout.Tight);
        var style = _layout.RowStyles[2];
        if ((int)style.Height != noticeHeight) style.Height = noticeHeight;
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
        var parts = BarText.Parts(stage);
        _dot.ForeColor = BarText.Color(stage) switch { BarColor.Recording => Red, BarColor.Paused => Amber, _ => SystemColors.GrayText };
        _state.Text = BarText.StateLine(stage, _starting ?? _capture.ProgramPath, _shown.Count);
        _guidance.Text = stage == BarStage.Saved
            ? BarText.Guidance(stage, Path.GetFileName(_savedRecording), SaveNames.FolderShown(_folder, _documents))
            : BarText.Guidance(stage);
        _startRow.Visible = parts.HasFlag(BarPart.StartButtons);
        _readyText.Visible = parts.HasFlag(BarPart.ReadyText);
        _recordRow.Visible = parts.HasFlag(BarPart.RecordButtons);
        _listArea.Visible = parts.HasFlag(BarPart.List);
        _empty.Visible = _shown.Count == 0;
        _readHint.Visible = parts.HasFlag(BarPart.ReadHint);
        _actions.Visible = parts.HasFlag(BarPart.StepActions);
        _saveBlock.Visible = parts.HasFlag(BarPart.SaveBlock);
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
        }
        AcceptButton = BarText.Primary(stage, allow) switch
        {
            BarText.StartApp => _startApp,
            BarText.Save => _save,
            NextSteps.AllowButton => _allowButton,
            NextSteps.ShowFile => _showFile,
            _ => null,
        };
        ShowActions();
    }

    private void ShowActions()
    {
        var i = _list.SelectedIndex;
        var actions = StepRows.ActionsFor(i >= 0 && i < _shown.Count ? _shown[i] : null, i + 1);
        _delete.Enabled = actions.Delete;
        _variable.Enabled = actions.Variable;
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
        _list.ShowRows(StepRows.Of(steps), follow);
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

    private void Finish()
    {
        _capture.Stop();
        if (_name.Text.Trim().Length == 0) _name.Text = SaveNames.SuggestedName(_capture.ProgramPath);
        ShowStage(BarStage.Finished);
        _name.Focus();
        _name.SelectAll();
    }

    private void Delete()
    {
        var i = _list.SelectedIndex;
        if (i >= 0) _capture.Use(s => { s.Delete(i); return 0; });
        BackToApp();
    }

    private void Mark(bool secret)
    {
        var i = _list.SelectedIndex;
        if (i < 0 || i >= _shown.Count) return;
        var question = secret ? DialogText.Secret(i + 1, _shown[i]) : DialogText.Variable(i + 1, _shown[i]);
        using var dialog = new NameDialog(this, question, []);
        if (Ask(dialog))
        {
            var name = dialog.Answer;
            try { _capture.Use(s => { if (secret) s.MarkSecret(i, name); else s.MarkVariable(i, name); return 0; }); }
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
        if (IsDisposed) return;
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
                UseShellExecute = true, Verb = "runas", Arguments = NextSteps.ApplyArguments(change), WorkingDirectory = Path.GetDirectoryName(tool)!,
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

    /// <summary>Starts over with a new recording, after asking when the steps are not saved.</summary>
    private void RecordAnother()
    {
        if (StepRows.Unsaved(_saved, _shown) && !Confirm(DialogText.StartOverUnsaved(_shown.Count))) return;
        _capture.Dispose();
        _capture = NewCapture();
        _shown = [];
        _saved = null;
        _savedRecording = _savedChange = null;
        _allow = AllowState.NotDone;
        _name.Text = "";
        _list.ShowRows([], followNewest: false);
        ClearNotices();
        ShowStage(BarStage.Ready);
    }

    private void ShowEarlierNotices()
    {
        using var dialog = new NoticesDialog(this, _notices.Earlier);
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
