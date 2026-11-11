using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// The look all of the bar's small windows share: the system font on a window background, a text column of one width,
/// and normal-size buttons at the bottom right, the action first and then Cancel. It opens beside the bar, so that the
/// list it is about stays in view, stays on top like the bar, and becomes the active window when it opens (also when
/// the app had the foreground, as at F9), so that Enter and typing reach it. Its texts come from <see cref="DialogText"/>.
/// </summary>
internal abstract class SmallDialog : Form
{
    private readonly TableLayoutPanel _body;
    private readonly FlowLayoutPanel _buttons;
    private readonly Form _bar;

    protected SmallDialog(Form bar, string title)
    {
        _bar = bar;
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = title;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        ShowInTaskbar = false;
        ShowIcon = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = SystemColors.Window;
        // Not AutoSize: a form that sizes itself measures its children by their bounds, and a docked child takes its
        // width from the form instead of giving one, so the form shrank to its title (136 pixels). The window's size
        // is the body's own preferred size instead (Fit).
        Padding = new Padding(BarLayout.Edge);
        _body = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, Margin = Padding.Empty };
        _body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, BarLayout.DialogWidth));
        _buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false,
            Anchor = AnchorStyles.Right, Margin = new Padding(0, BarLayout.Group, 0, 0),
        };
        Load += (_, _) =>
        {
            Fit();
            Location = BarLayout.Beside(_bar.Bounds, Size, Screen.FromControl(_bar).WorkingArea, LogicalToDeviceUnits(BarLayout.Space));
            // A problem line that appears or wraps changes the body's height: the window follows.
            _body.SizeChanged += (_, _) => Fit();
        };
        Shown += (_, _) => Native.TakeForeground(Handle);
    }

    /// <summary>The window's client area is the body's preferred size (its fixed-width column, its rows) and the padding.</summary>
    private void Fit()
    {
        var body = _body.GetPreferredSize(Size.Empty);
        var size = new Size(body.Width + Padding.Horizontal, body.Height + Padding.Vertical);
        if (ClientSize != size) ClientSize = size;
    }

    /// <summary>Adds the buttons last: <paramref name="action"/> and, unless null, Cancel. The default button is
    /// <paramref name="safeDefault"/> ? Cancel : the action.</summary>
    protected Button Finish(string action, string? cancel = DialogText.Cancel, bool safeDefault = false)
    {
        Button? no = null;
        if (cancel is not null)
        {
            no = NewButton(cancel);
            no.DialogResult = DialogResult.Cancel;
            CancelButton = no;
            // Right to left: Cancel goes in first, so it ends up to the right of the action.
            _buttons.Controls.Add(no);
        }
        var yes = NewButton(action);
        yes.DialogResult = DialogResult.OK;
        _buttons.Controls.Add(yes);
        if (no is null) CancelButton = yes;
        AcceptButton = safeDefault && no is not null ? no : yes;
        _body.Controls.Add(_buttons);
        Controls.Add(_body);
        ResumeLayout(false);
        PerformLayout();
        return yes;
    }

    protected void Add(Control control) => _body.Controls.Add(control);

    /// <summary>A text that wraps in the dialog's column.</summary>
    protected Label AddText(string text, bool quiet = false, int top = 0)
    {
        var label = NewLabel(text, quiet);
        label.Margin = new Padding(0, top, 0, BarLayout.Tight);
        Add(label);
        return label;
    }

    internal static Label NewLabel(string text, bool quiet = false) => new()
    {
        Text = text, AutoSize = true, UseMnemonic = false, MaximumSize = new Size(BarLayout.DialogWidth, 0),
        ForeColor = quiet ? SystemColors.GrayText : SystemColors.WindowText,
    };

    /// <summary>
    /// A standard button: as high as its font makes it and at least the standard 75 wide (both scaled with the screen).
    /// GrowAndShrink, so its size is always worked out from its text and font: a size kept from before (GrowOnly keeps
    /// the largest one it ever had, and the default 75 x 23 is scaled along with the form) cannot make it taller.
    /// </summary>
    internal static Button NewButton(string text) => new()
    {
        Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(75, 0), UseMnemonic = false,
        Margin = new Padding(BarLayout.Space, 0, 0, 0), UseVisualStyleBackColor = true,
    };
}

/// <summary>Make variable…, Make secret… and the F9 question: what the step does, a labelled name box with a
/// suggestion, and one line with the name rule (or what is wrong with the name typed).</summary>
internal sealed class NameDialog : SmallDialog
{
    private readonly TextBox _box;
    private readonly Label _rule;
    private readonly Button _action;
    private readonly IReadOnlyCollection<string> _taken;

    public NameDialog(Form bar, NameQuestion question, IReadOnlyCollection<string> taken) : base(bar, question.Title)
    {
        _taken = taken;
        AddText(question.Text);
        AddText(question.NameLabel, top: BarLayout.Space);
        _box = new TextBox { Text = question.Suggested, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
        Add(_box);
        _rule = AddText(DialogText.NameRule, quiet: true);
        _action = Finish(question.Action);
        _box.TextChanged += (_, _) => Check();
        Shown += (_, _) => { _box.Focus(); _box.SelectAll(); };
        Check();
    }

    public string Answer => _box.Text.Trim();

    private void Check()
    {
        var problem = DialogText.NameProblem(_box.Text, _taken);
        _rule.Text = problem ?? DialogText.NameRule;
        _rule.ForeColor = problem is null ? SystemColors.GrayText : RecorderBar.Amber;
        _action.Enabled = problem is null;
    }
}

/// <summary>Start an app: the program (typed or picked with Browse…, which opens in Program Files) and its optional
/// arguments, with the note that they are saved. Start recording is enabled once the program can be tried.</summary>
internal sealed class StartDialog : SmallDialog
{
    private readonly TextBox _program;
    private readonly TextBox _arguments;
    private readonly Label _problem;
    private readonly Button _action;

    public StartDialog(Form bar) : base(bar, DialogText.StartTitle)
    {
        AddText(DialogText.StartProgram);
        var row = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _program = new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 1, 0, 0) };
        var browse = NewButton(DialogText.Browse);
        row.Controls.Add(_program, 0, 0);
        row.Controls.Add(browse, 1, 0);
        Add(row);
        AddText(DialogText.StartArguments, top: BarLayout.Space);
        _arguments = new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, BarLayout.Tight) };
        Add(_arguments);
        AddText(DialogText.QuotesNote, quiet: true);
        AddText(DialogText.ArgumentsNote, quiet: true);
        _problem = AddText("", top: BarLayout.Tight);
        _problem.ForeColor = RecorderBar.Amber;
        _action = Finish(DialogText.StartAction);
        browse.Click += (_, _) => Browse();
        _program.TextChanged += (_, _) => Check();
        _arguments.TextChanged += (_, _) => Check();
        Check();
    }

    public string Program => _program.Text.Trim();

    public IReadOnlyList<string> Arguments => CommandLine.Split(_arguments.Text);

    /// <summary>Picks the program. Afterwards the arguments box is the active control, not Browse…: a focused button is
    /// the one Enter presses and the one drawn as the default, so with the focus in a box Start recording is the default
    /// again. ActiveControl, not only Focus(): when the picker closes, Windows activates this window again and WinForms
    /// gives the focus back to the form's active control.</summary>
    private void Browse()
    {
        using var pick = new OpenFileDialog
        {
            Title = DialogText.PickTitle, Filter = "Programs (*.exe)|*.exe", CheckFileExists = true,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        };
        if (pick.ShowDialog(this) != DialogResult.OK) return;
        _program.Text = pick.FileName;
        ActiveControl = _arguments;
    }

    private void Check()
    {
        var problem = DialogText.StartProblem(_program.Text, _arguments.Text, File.Exists);
        _action.Enabled = problem is null;
        // An empty box needs no warning: the disabled button and the label say what is missing.
        _problem.Text = _program.Text.Trim().Length == 0 ? "" : problem ?? "";
    }
}

/// <summary>Use an app that is already open: the titled windows of other programs, one to choose.</summary>
internal sealed class OpenAppDialog : SmallDialog
{
    private readonly ListBox _windows;

    public OpenAppDialog(Form bar, IReadOnlyList<string> windows) : base(bar, DialogText.OpenTitle)
    {
        AddText(windows.Count == 0 ? DialogText.OpenNone : DialogText.OpenText);
        _windows = new ListBox { Dock = DockStyle.Fill, Height = 180, IntegralHeight = false, Margin = new Padding(0, BarLayout.Tight, 0, 0), Visible = windows.Count > 0 };
        _windows.Items.AddRange(windows.Cast<object>().ToArray());
        Add(_windows);
        var action = Finish(DialogText.StartAction);
        action.Enabled = false;
        _windows.SelectedIndexChanged += (_, _) => action.Enabled = _windows.SelectedIndex >= 0;
        _windows.DoubleClick += (_, _) => { if (_windows.SelectedIndex >= 0) DialogResult = DialogResult.OK; };
    }

    public int Choice => _windows.SelectedIndex;
}

/// <summary>A question before work is lost or replaced: its text, the action, and Cancel as the default.</summary>
internal sealed class QuestionDialog : SmallDialog
{
    public QuestionDialog(Form bar, Question question) : base(bar, question.Title)
    {
        AddText(question.Text);
        Finish(question.Action, safeDefault: true);
    }
}

/// <summary>The notices, newest first, each with its time: the one on the bar's line (which may be cut) and the earlier ones.</summary>
internal sealed class NoticesDialog : SmallDialog
{
    public NoticesDialog(Form bar, IEnumerable<BarNotice> notices) : base(bar, DialogText.NoticesTitle)
    {
        var list = new TextBox
        {
            Multiline = true, ReadOnly = true, WordWrap = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 220,
            BackColor = SystemColors.Window, Text = string.Join(Environment.NewLine + Environment.NewLine, notices.Select(NoticeLine.Listed)),
        };
        Add(list);
        Finish(DialogText.Close, cancel: null);
        Shown += (_, _) => list.Select(0, 0);
    }
}
