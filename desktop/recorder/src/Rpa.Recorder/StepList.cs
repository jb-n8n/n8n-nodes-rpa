using Rpa.Recorder.Core;

namespace Rpa.Recorder;

/// <summary>
/// The bar's step list: a list box that draws each row as its number, its sentence (wrapped, never scrolled sideways)
/// and its mark, with the mark's reason as the row's tooltip. What the rows say is decided in Rpa.Recorder.Core
/// (<see cref="StepRows"/>); this class only measures and draws them in the system's colours.
/// </summary>
internal sealed class StepList : ListBox
{
    private const TextFormatFlags Flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding;
    // A list box row is at most 255 pixels high.
    private const int MaxRowHeight = 255;
    private readonly ToolTip _tip = new() { AutoPopDelay = 20000, InitialDelay = 400, ReshowDelay = 200 };
    private IReadOnlyList<StepRow> _rows = [];
    private int[] _heights = [];
    private int _tipRow = -1;
    private int _measuredWidth;
    private Font? _markFont;

    public StepList()
    {
        DrawMode = DrawMode.OwnerDrawVariable;
        IntegralHeight = false;
        HorizontalScrollbar = false;
        // The scroll bar is always there, so the width a row wraps in does not change when the list grows.
        ScrollAlwaysVisible = true;
        BorderStyle = BorderStyle.FixedSingle;
    }

    public IReadOnlyList<StepRow> Rows => _rows;

    /// <summary>Shows the rows, keeping the selected row. With <paramref name="followNewest"/> the list scrolls so that
    /// the last row is in view; otherwise it stays where it was.</summary>
    public void ShowRows(IReadOnlyList<StepRow> rows, bool followNewest)
    {
        var selected = SelectedIndex;
        var top = TopIndex;
        _rows = rows;
        _heights = new int[rows.Count];
        _measuredWidth = ClientSize.Width;
        BeginUpdate();
        Items.Clear();
        // The items are the rows as a screen reader says them; drawing uses the rows themselves.
        foreach (var row in rows) Items.Add(row.Mark == StepMark.None ? $"{row.Number}. {row.Text}" : $"{row.Number}. {row.Text} ({StepRows.MarkText(row.Mark)})");
        if (selected >= 0 && rows.Count > 0) SelectedIndex = Math.Min(selected, rows.Count - 1);
        EndUpdate();
        if (rows.Count == 0) return;
        TopIndex = followNewest ? StepRows.TopIndexShowingLast(_heights, ClientSize.Height) : Math.Min(top, rows.Count - 1);
    }

    protected override void OnMeasureItem(MeasureItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= _rows.Count) return;
        var row = _rows[e.Index];
        var (_, text, _) = Areas(new Rectangle(0, 0, ClientSize.Width, 0), row);
        var size = TextRenderer.MeasureText(e.Graphics, row.Text, Font, new Size(Math.Max(1, text.Width), int.MaxValue), Flags);
        var height = Math.Min(MaxRowHeight, Math.Max(size.Height, Font.Height) + 2 * Pad);
        e.ItemHeight = height;
        if (e.Index < _heights.Length) _heights[e.Index] = height;
    }

    protected override void OnDrawItem(DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= _rows.Count) return;
        var row = _rows[e.Index];
        var selected = (e.State & DrawItemState.Selected) != 0;
        using (var back = new SolidBrush(selected ? SystemColors.Highlight : SystemColors.Window)) e.Graphics.FillRectangle(back, e.Bounds);
        var fore = selected ? SystemColors.HighlightText : SystemColors.WindowText;
        var quiet = selected ? SystemColors.HighlightText : SystemColors.GrayText;
        var (number, text, mark) = Areas(e.Bounds, row);
        TextRenderer.DrawText(e.Graphics, row.Number.ToString(System.Globalization.CultureInfo.InvariantCulture), Font, number, quiet, Flags | TextFormatFlags.Right);
        TextRenderer.DrawText(e.Graphics, row.Text, Font, text, fore, Flags);
        if (row.Mark != StepMark.None)
            TextRenderer.DrawText(e.Graphics, StepRows.MarkText(row.Mark), MarkFont, mark, row.Mark == StepMark.Check && !selected ? RecorderBar.Amber : quiet, Flags);
        e.DrawFocusRectangle();
    }

    /// <summary>A row's three parts: its number at the left, its mark at the right, its sentence between them.</summary>
    private (Rectangle Number, Rectangle Text, Rectangle Mark) Areas(Rectangle bounds, StepRow row)
    {
        var pad = Pad;
        var digits = Math.Max(2, _rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture).Length);
        var numberWidth = TextRenderer.MeasureText(new string('0', digits), Font, Size.Empty, Flags).Width;
        var markWidth = row.Mark == StepMark.None ? 0 : TextRenderer.MeasureText(StepRows.MarkText(row.Mark), MarkFont, Size.Empty, Flags).Width;
        var top = bounds.Top + pad;
        var height = Math.Max(0, bounds.Height - 2 * pad);
        var number = new Rectangle(bounds.Left + pad, top, numberWidth, height);
        var mark = new Rectangle(bounds.Right - pad - markWidth, top, markWidth, height);
        var textLeft = number.Right + 2 * pad;
        var textRight = row.Mark == StepMark.None ? bounds.Right - pad : mark.Left - 2 * pad;
        return (number, new Rectangle(textLeft, top, Math.Max(1, textRight - textLeft), height), mark);
    }

    private int Pad => LogicalToDeviceUnits(BarLayout.Tight);

    private Font MarkFont => _markFont ??= new Font(Font.FontFamily, Math.Max(7f, Font.SizeInPoints - 1f));

    protected override void OnFontChanged(EventArgs e)
    {
        _markFont?.Dispose();
        _markFont = null;
        base.OnFontChanged(e);
        Remeasure();
    }

    protected override void OnDpiChangedAfterParent(EventArgs e)
    {
        base.OnDpiChangedAfterParent(e);
        Remeasure();
    }

    /// <summary>Rows are measured for the list's width: when it changes, they are measured again.</summary>
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (ClientSize.Width != _measuredWidth) Remeasure();
    }

    private void Remeasure()
    {
        if (_rows.Count > 0) ShowRows(_rows, followNewest: false);
        else _measuredWidth = ClientSize.Width;
    }

    /// <summary>The tooltip of the row under the pointer: why it has its mark.</summary>
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var index = IndexFromPoint(e.Location);
        if (index == _tipRow) return;
        _tipRow = index;
        _tip.SetToolTip(this, index >= 0 && index < _rows.Count ? _rows[index].Tip ?? "" : "");
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        _tipRow = -1;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tip.Dispose();
            _markFont?.Dispose();
        }
        base.Dispose(disposing);
    }
}
