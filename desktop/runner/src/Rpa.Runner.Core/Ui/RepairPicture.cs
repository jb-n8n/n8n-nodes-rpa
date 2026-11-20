using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Ui;

/// <summary>Why no picture was made for a look; the text is safe to show (it never holds a value of the app).</summary>
public sealed class PictureRefusedException(string message) : Exception(message);

/// <summary>
/// The masked, labelled picture AI repair's <c>look</c> sends to the chat model (set-of-marks): the run's own top-level
/// windows composed on black, each from its own pixels, never the desktop and never another application's window.
/// Before anything leaves the runner, an opaque black box covers every control that is a password or credential-like
/// field (<see cref="Redaction.HidesValue"/>), every control the run typed into (by runtime id, or by process, type and
/// automation id), and every control whose name, value, document text or accessible name or value holds one of the
/// masked texts (the engine's typed variable values and clipboard texts, and every text the run typed). An element
/// whose text content cannot be read is covered whole. The controls are found in UI Automation's raw view, before and
/// after the capture, and every box from both passes is covered. It fails closed: no picture
/// (<see cref="PictureRefusedException"/>) when such a control's rectangle cannot be read, a window cannot be read
/// through UI Automation, a window moved or changed size during the capture, Windows scales a window's drawing (DPI), a
/// window holds a child window of another application, a window's title holds a masked text, or there are too many
/// elements to check.
/// </summary>
public static class RepairPicture
{
    /// <summary>The longest side of a picture, after shrinking.</summary>
    public const int MaxEdge = 1280;

    /// <summary>Elements checked for masking across all windows in one pass; more is a refusal, never a partial check.</summary>
    public const int MaxCheckedElements = 5000;

    /// <summary>The largest composed area before shrinking (a 8192 by 8192 picture).</summary>
    public const long MaxComposedPixels = 8192L * 8192L;

    /// <summary>Masked texts shorter than this are not looked for (as the engine: a one-letter value would mask everything).</summary>
    public const int MinMaskedText = 4;

    /// <summary>Black boxes reach this far past a control's bounds (focus rectangles, anti-aliased edges).</summary>
    public const int MaskPadding = 2;

    /// <summary>Control types that get a number label: the controls a repair acts on. Not grid cells (DataItem) or text: a
    /// label on every cell hides the data, and the text view lists their refs.</summary>
    private static readonly HashSet<string> Labelled = new(StringComparer.OrdinalIgnoreCase)
    {
        "Button", "MenuItem", "TabItem", "ListItem", "TreeItem", "Edit", "ComboBox", "CheckBox", "RadioButton", "Hyperlink",
        "SplitButton", "Document",
    };

    /// <summary>One window of the run to draw.</summary>
    public sealed record Layer(IUiNode Window, WindowCapture Capture);

    /// <summary>A view node to label: its number and its element.</summary>
    public sealed record Mark(long Number, IUiNode Element);

    public sealed record Result(byte[] Png, int Width, int Height, int Masked, int Labels, Raster Picture);

    /// <param name="windows">The run's windows, front to back (as <c>windows</c> lists them).</param>
    /// <param name="shown">The window the snapshot is of: it must be in the picture.</param>
    /// <param name="capture">A window's own pixels (IDesktop.CaptureWindow); null when it is minimized.</param>
    /// <param name="windowRect">A window's rectangle read again after the capture (IDesktop.GetWindowRect).</param>
    /// <param name="isRunProcess">Whether a process belongs to the run (WindowScope.IsRunProcess).</param>
    /// <param name="typedInto">Whether the run typed into the element (RunState.WasTypedInto).</param>
    /// <param name="maskTexts">Texts whose controls are covered.</param>
    /// <param name="marks">The view's nodes, each with the number its ref carries (ref e12 is label 12).</param>
    public static Result Make(IReadOnlyList<IUiNode> windows, IUiNode shown, Func<IUiNode, WindowCapture?> capture, Func<IUiNode, PixelRect?> windowRect,
        Func<int, bool> isRunProcess, Func<IUiNode, bool> typedInto, IReadOnlyList<string> maskTexts, IReadOnlyList<Mark> marks, int maxEdge = MaxEdge)
    {
        var texts = maskTexts.Where(t => t.Length >= MinMaskedText).Distinct(StringComparer.Ordinal).ToArray();

        // What to cover, before the capture and again after it: a field that got text or moved in between is covered
        // where it was and where it is.
        var boxes = Collect(windows, texts, typedInto);
        var layers = new List<Layer>();
        foreach (var w in windows)
        {
            var c = capture(w);
            if (c is not null) layers.Add(new Layer(w, c));
        }
        if (!layers.Any(l => l.Window.Id == shown.Id)) throw new PictureRefusedException("the window shown could not be captured");
        boxes.AddRange(Collect(layers.Select(l => l.Window).ToList(), texts, typedInto));

        var bounds = default(PixelRect);
        foreach (var l in layers)
        {
            if (l.Capture.Bounds.IsEmpty) throw new PictureRefusedException("a window of the run has no size");
            if ((long)l.Capture.Bounds.Width * l.Capture.Bounds.Height * 4 > l.Capture.Bgra.Length)
                throw new PictureRefusedException("a window capture is smaller than the window");
            if (l.Capture.DpiScaled) throw new PictureRefusedException("Windows scales a window's drawing for its display (DPI), so its pixels may not match the controls' positions");
            foreach (var pid in l.Capture.ChildProcessIds)
                if (!isRunProcess(pid)) throw new PictureRefusedException("a window of the run holds a window of another application");
            // The boxes are in screen coordinates: a window that moved or changed size since its capture would put them
            // in the wrong place.
            if (windowRect(l.Window) != l.Capture.Bounds) throw new PictureRefusedException("a window moved or changed size while the picture was taken");
            bounds = bounds.Union(l.Capture.Bounds);
        }
        if ((long)bounds.Width * bounds.Height > MaxComposedPixels) throw new PictureRefusedException("the run's windows cover too large an area");
        boxes = boxes.Distinct().ToList();

        var canvas = new Raster(bounds.Width, bounds.Height);
        for (var i = layers.Count - 1; i >= 0; i--)
        {
            var c = layers[i].Capture;
            canvas.Blit(c.Bgra, c.Bounds.Width, c.Bounds.Height, c.Bounds.X - bounds.X, c.Bounds.Y - bounds.Y);
        }
        foreach (var b in boxes) canvas.Fill(new PixelRect(b.X - bounds.X, b.Y - bounds.Y, b.Width, b.Height), 0, 0, 0);

        var shrunk = canvas.ShrinkTo(Math.Clamp(maxEdge, 64, MaxEdge), out var scale);

        // Labels go on after shrinking, so they stay readable; they hold digits only.
        var placed = new List<PixelRect>();
        foreach (var m in marks)
        {
            PixelRect? r;
            try
            {
                if (!Labelled.Contains(m.Element.ControlType)) continue;
                r = m.Element.Bounds;
            }
            catch (ElementGoneException)
            {
                continue;
            }
            if (r is not { IsEmpty: false } er || !er.Overlaps(bounds)) continue;
            var digits = m.Number.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var (w, h) = Raster.LabelSize(digits);
            var x = (int)Math.Round((er.X - bounds.X) * scale);
            var y = (int)Math.Round((er.Y - bounds.Y) * scale);
            var spot = new PixelRect(Math.Clamp(x, 0, Math.Max(0, shrunk.Width - w)), Math.Clamp(y, 0, Math.Max(0, shrunk.Height - h)), w, h);
            for (var tries = 0; tries < 4 && placed.Any(p => p.Overlaps(spot)); tries++)
                spot = spot with { X = Math.Min(spot.X + w + 1, Math.Max(0, shrunk.Width - w)) };
            shrunk.DrawLabel(digits, spot.X, spot.Y);
            placed.Add(spot);
        }
        return new Result(shrunk.EncodePng(), shrunk.Width, shrunk.Height, boxes.Count, placed.Count, shrunk);
    }

    /// <summary>The boxes to cover in these windows: one pass over each window's whole raw view.</summary>
    private static List<PixelRect> Collect(IReadOnlyList<IUiNode> windows, string[] texts, Func<IUiNode, bool> typedInto)
    {
        var boxes = new List<PixelRect>();
        var checkedCount = 0;
        foreach (var window in windows)
        {
            // The window's own title is drawn in its title bar: a masked text there would need the whole window covered.
            if (Holds(window.Name, texts)) throw new PictureRefusedException("a window title shows a value the run masks");
            if (Redaction.HidesValue(window) || typedInto(window)) throw new PictureRefusedException("a whole window would have to be covered");
            IReadOnlyList<IUiNode> all;
            try
            {
                // Every element of the window in the raw view, not only control elements; a window UI Automation cannot
                // read throws here.
                all = window.RawDescendants();
            }
            catch (ElementGoneException)
            {
                throw new PictureRefusedException("a window of the run cannot be read through UI Automation");
            }
            checkedCount += all.Count;
            if (checkedCount > MaxCheckedElements) throw new PictureRefusedException($"the run's windows hold more than {MaxCheckedElements} elements to check");
            foreach (var n in all)
            {
                if (!MustCover(n, texts, typedInto)) continue;
                var r = n.Bounds ?? throw new PictureRefusedException("the position of a control that must be covered cannot be read");
                if (r.IsEmpty)
                {
                    // Nothing of it is drawn only when UI Automation says it is off the screen.
                    if (n.IsOffscreen) continue;
                    throw new PictureRefusedException("a control that must be covered reports no size");
                }
                boxes.Add(r.Inflate(MaskPadding));
            }
        }
        return boxes;
    }

    private static bool MustCover(IUiNode n, string[] texts, Func<IUiNode, bool> typedInto)
    {
        // A hidden value is never read; it is covered anyway.
        if (Redaction.HidesValue(n) || typedInto(n)) return true;
        if (texts.Length == 0) return false;
        if (Holds(n.Name, texts) || Holds(n.Value, texts)) return true;
        // Document text and accessible name or value; content that cannot be read is covered whole.
        var other = n.OtherTexts;
        return other is null || other.Any(t => Holds(t, texts));
    }

    private static bool Holds(string? value, string[] texts) =>
        value is { Length: > 0 } && texts.Any(t => value.Contains(t, StringComparison.OrdinalIgnoreCase));
}
