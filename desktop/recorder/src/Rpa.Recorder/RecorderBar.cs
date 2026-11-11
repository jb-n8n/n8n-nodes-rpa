using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// The recorder's bar: a small window that stays on top. Start (a program, or a window that is already open), Pause,
/// Stop, Save; the steps as plain sentences; Delete, Mark as variable, Mark as secret; F9 reads the value under the
/// pointer. Notices (an answer that came late, input the hooks missed, a program that runs as administrator) appear
/// in the box at the bottom. The bar's own windows are never recorded.
/// </summary>
internal sealed class RecorderBar : Form
{
    private readonly Capture _capture = new(readKey: true);
    private readonly Button _startProgram = new() { Text = "Start a program...", AutoSize = true };
    private readonly Button _startWindow = new() { Text = "Record an open window...", AutoSize = true };
    private readonly Button _pause = new() { Text = "Pause", AutoSize = true, Enabled = false };
    private readonly Button _stop = new() { Text = "Stop", AutoSize = true, Enabled = false };
    private readonly Button _save = new() { Text = "Save...", AutoSize = true, Enabled = false };
    private readonly TextBox _name = new() { PlaceholderText = "Name of the recording", Dock = DockStyle.Fill };
    private readonly ListBox _steps = new() { Dock = DockStyle.Fill, IntegralHeight = false, HorizontalScrollbar = true };
    private readonly Button _delete = new() { Text = "Delete", AutoSize = true };
    private readonly Button _variable = new() { Text = "Mark as variable...", AutoSize = true };
    private readonly Button _secret = new() { Text = "Mark as secret...", AutoSize = true };
    private readonly TextBox _notices = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 90 };
    private bool _started, _stopped;

    public RecorderBar()
    {
        Text = "RPA Recorder";
        TopMost = true;
        FormBorderStyle = FormBorderStyle.SizableToolWindow;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Screen.PrimaryScreen?.WorkingArea.Right - 520 ?? 0, 40);
        Size = new Size(500, 460);

        var top = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true };
        top.Controls.AddRange([_startProgram, _startWindow, _pause, _stop, _save]);
        var edit = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
        edit.Controls.AddRange([_delete, _variable, _secret, new Label { Text = "F9: read the value under the pointer", AutoSize = true, Padding = new Padding(0, 8, 0, 0) }]);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));
        layout.Controls.Add(top, 0, 0);
        layout.Controls.Add(_name, 0, 1);
        layout.Controls.Add(_steps, 0, 2);
        layout.Controls.Add(edit, 0, 3);
        layout.Controls.Add(_notices, 0, 4);
        Controls.Add(layout);
        Say(Notices.Arguments);
        Say(Notices.CtrlAltShortcuts);

        _startProgram.Click += async (_, _) => await StartProgram();
        _startWindow.Click += (_, _) => StartOnWindow();
        _pause.Click += (_, _) => TogglePause();
        _stop.Click += (_, _) => { _capture.Stop(); _stopped = true; UpdateButtons(); };
        _save.Click += (_, _) => Save();
        _delete.Click += (_, _) => { if (Selected() is { } i) _capture.Use(s => { s.Delete(i); return 0; }); };
        _variable.Click += (_, _) => Mark(secret: false);
        _secret.Click += (_, _) => Mark(secret: true);
        _capture.Changed += () => BeginInvoke(Refresh);
        _capture.Noticed += n => BeginInvoke(() => Say($"{n.At:HH:mm:ss} {n.Text}"));
        _capture.ReadRequested += (element, window) => BeginInvoke(() => AskRead(element, window));
        FormClosed += (_, _) => _capture.Dispose();
        UpdateButtons();
    }

    private async Task StartProgram()
    {
        using var pick = new OpenFileDialog { Title = "The program to record", Filter = "Programs (*.exe)|*.exe" };
        if (pick.ShowDialog(this) != DialogResult.OK) return;
        var line = Ask("Arguments", $"Arguments for {Path.GetFileName(pick.FileName)} (optional, separated by spaces).\r\n{Notices.Arguments}", "");
        if (line is null) return;
        var args = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        _startProgram.Enabled = _startWindow.Enabled = false;
        try
        {
            if (await Task.Run(() => _capture.Launch(pick.FileName, args))) _started = true;
        }
        catch (ArgumentException e) { MessageBox.Show(this, e.Message, Text); }
        UpdateButtons();
    }

    private void StartOnWindow()
    {
        var own = (uint)Environment.ProcessId;
        var windows = Native.TopLevelWindows()
            .Where(h => Native.ProcessOf(h) != own && Native.TitleOf(h).Length > 0)
            .Select(h => (Handle: h, Text: $"{Native.TitleOf(h)} ({UiaWorker.ExeOf(Native.ProcessOf(h))})"))
            .ToList();
        using var dialog = new Form { Text = "Record an open window", Size = new Size(460, 360), StartPosition = FormStartPosition.CenterParent, TopMost = true };
        var list = new ListBox { Dock = DockStyle.Fill };
        list.Items.AddRange(windows.Select(w => (object)w.Text).ToArray());
        var ok = new Button { Text = "Record", Dock = DockStyle.Bottom, DialogResult = DialogResult.OK };
        dialog.Controls.Add(list);
        dialog.Controls.Add(ok);
        dialog.AcceptButton = ok;
        if (dialog.ShowDialog(this) != DialogResult.OK || list.SelectedIndex < 0) return;
        if (_capture.Attach(windows[list.SelectedIndex].Handle)) _started = true;
        UpdateButtons();
    }

    private void TogglePause()
    {
        _capture.Pause(_capture.Recording);
        _pause.Text = _capture.Recording ? "Pause" : "Resume";
    }

    private void Mark(bool secret)
    {
        if (Selected() is not { } i) return;
        var step = _capture.Steps()[i].Step;
        var name = Ask(secret ? "Mark as secret" : "Mark as variable",
            secret ? "The run variable that holds this secret. The typed value is removed from the recording." : "The run variable this value comes from on each run.",
            StepText.SuggestedName(step));
        if (name is null) return;
        try { _capture.Use(s => { if (secret) s.MarkSecret(i, name); else s.MarkVariable(i, name); return 0; }); }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException) { MessageBox.Show(this, e.Message, Text); }
    }

    private void AskRead(ElementFacts element, WindowFacts window)
    {
        var name = Ask("Read value", $"Read \"{LocatorRules.Label(element)}\" into this run output:", "out_" + SecretRules.VariableName(element));
        if (name is null) return;
        try { _capture.AddRead(element, window, name); }
        catch (ArgumentException e) { MessageBox.Show(this, e.Message, Text); }
    }

    private void Save()
    {
        var name = _name.Text.Trim();
        if (name.Length == 0) { MessageBox.Show(this, "Give the recording a name first.", Text); return; }
        using var folder = new FolderBrowserDialog { Description = "The folder for the recording file and the policy change file" };
        if (folder.ShowDialog(this) != DialogResult.OK) return;
        var paths = new[] { Path.Combine(folder.SelectedPath, SaveNames.Recording(name)), Path.Combine(folder.SelectedPath, SaveNames.PolicyChange(name)) };
        var existing = paths.Where(File.Exists).ToArray();
        if (existing.Length > 0 && MessageBox.Show(this, $"Replace {string.Join(" and ", existing.Select(Path.GetFileName))}?", Text, MessageBoxButtons.YesNo) != DialogResult.Yes) return;
        try
        {
            _capture.Save(folder.SelectedPath, name, overwrite: existing.Length > 0);
            Say($"Saved {Path.GetFileName(paths[0])} and {Path.GetFileName(paths[1])}. An administrator applies the policy change with RpaPolicy.exe apply.");
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            MessageBox.Show(this, e.Message, Text);
        }
    }

    private new void Refresh()
    {
        var selected = _steps.SelectedIndex;
        _steps.BeginUpdate();
        _steps.Items.Clear();
        foreach (var (step, late) in _capture.Steps()) _steps.Items.Add(StepText.Sentence(step) + (late ? "  [check this step]" : ""));
        _steps.SelectedIndex = Math.Min(selected, _steps.Items.Count - 1);
        _steps.EndUpdate();
        UpdateButtons();
    }

    private void UpdateButtons()
    {
        _startProgram.Enabled = _startWindow.Enabled = !_started;
        _pause.Enabled = _stop.Enabled = _started && !_stopped;
        _save.Enabled = _stopped;
    }

    private int? Selected() => _steps.SelectedIndex >= 0 ? _steps.SelectedIndex : null;

    private void Say(string text) => _notices.AppendText(text + Environment.NewLine);

    /// <summary>A small question with one line of text; null when the person cancels.</summary>
    private string? Ask(string title, string question, string answer)
    {
        using var dialog = new Form { Text = title, Size = new Size(460, 190), StartPosition = FormStartPosition.CenterParent, TopMost = true, FormBorderStyle = FormBorderStyle.FixedDialog, MinimizeBox = false, MaximizeBox = false };
        var label = new Label { Text = question, Dock = DockStyle.Top, Height = 64 };
        var box = new TextBox { Text = answer, Dock = DockStyle.Top };
        var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Dock = DockStyle.Bottom };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Dock = DockStyle.Bottom };
        dialog.Controls.AddRange([box, label, cancel, ok]);
        dialog.AcceptButton = ok;
        dialog.CancelButton = cancel;
        return dialog.ShowDialog(this) == DialogResult.OK ? box.Text.Trim() : null;
    }
}
