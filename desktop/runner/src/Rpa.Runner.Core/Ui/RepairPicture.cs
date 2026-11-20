using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Ui;

/// <summary>Why no picture was made for a look; the text is safe to show (it never holds a value of the app).</summary>
public sealed class PictureRefusedException(string message) : Exception(message);

/// <summary>
/// The masked, labelled picture AI repair's <c>look</c> sends to the chat model (set-of-marks): the run's own top-level
/// windows composed on black, each from its own pixels, never the desktop and never another application's window.
/// Before anything leaves the runner, an opaque black box covers every control that is a password or credential-like
/// field (<see cref="Redaction.HidesValue"/>), every control the run typed into, and every control whose name or value
/// holds one of the texts the engine masks (the run's typed variable values and clipboard texts). It fails closed: when
/// such a control's rectangle cannot be read, a window cannot be read through UI Automation, a window holds a child
/// window of another application, a window's title holds a masked text, or there are too many elements to check, it
/// throws <see cref="PictureRefusedException"/> and no picture is made.
/// </summary>
public static class RepairPicture
{
    /// <summary>The longest side of a picture, after shrinking.</summary>
    public const int MaxEdge = 1280;

    /// <summary>Elements checked for masking across all windows of one picture; more is a refusal, never a partial check.</summary>
    public const int MaxCheckedElements = 5000;

    /// <summary>The largest composed area before shrinking (a 8192 by 8192 picture).</summary>
    public const long MaxComposedPixels = 8192L * 8192L;

    /// <summary>Masked texts shorter than this are not looked for (as the engine: a one-letter value would mask everything).</summary>
    public const int MinMaskedText = 4;

    /// <summary>Black boxes reach this far past a control's bounds (focus rectangles, anti-aliased edges).</summary>
    public const int MaskPadding = 2;

    /// <summary>Control types that get a number label.</summary>
    private static readonly HashSet<string> Labelled = new(StringComparer.OrdinalIgnoreCase)
    {
        "Button", "MenuItem", "TabItem", "ListItem", "TreeItem", "Edit", "ComboBox", "CheckBox", "RadioButton", "Hyperlink",
        "SplitButton", "Document", "DataItem",
    };

    /// <summary>One window of the run to draw, back to front order is the caller's.</summary>
    public sealed record Layer(IUiNode Window, WindowCapture Capture);

    /// <summary>A view node to label: its number and its element.</summary>
    public sealed record Mark(long Number, IUiNode Element);

    public sealed record Result(byte[] Png, int Width, int Height, int Masked, int Labels, Raster Picture);

    /// <param name="layers">The run's windows, front to back (as <c>windows</c> lists them).</param>
    /// <param name="isRunProcess">Whether a process belongs to the run (WindowScope.IsRunProcess).</param>
    /// <param name="typedInto">Whether the run typed into the element (by its runtime id).</param>
    /// <param name="maskTexts">Texts whose controls are covered: the engine's typed variable values and clipboard texts.</param>
    /// <param name="marks">The view's nodes, each with the number its ref carries (ref e12 is label 12).</param>
    public static Result Make(IReadOnlyList<Layer> layers, Func<int, bool> isRunProcess, Func<string, bool> typedInto,
        IReadOnlyList<string> maskTexts, IReadOnlyList<Mark> marks, int maxEdge = MaxEdge)
    {
        if (layers.Count == 0) throw new PictureRefusedException("no window of the run could be captured");
        var texts = maskTexts.Where(t => t.Length >= MinMaskedText).Distinct(StringComparer.Ordinal).ToArray();

        var bounds = default(PixelRect);
        foreach (var l in layers)
        {
            if (l.Capture.Bounds.IsEmpty) throw new PictureRefusedException("a window of the run has no size");
            if ((long)l.Capture.Bounds.Width * l.Capture.Bounds.Height * 4 > l.Capture.Bgra.Length)
                throw new PictureRefusedException("a window capture is smaller than the window");
            foreach (var pid in l.Capture.ChildProcessIds)
                if (!isRunProcess(pid)) throw new PictureRefusedException("a window of the run holds a window of another application");
            bounds = bounds.Union(l.Capture.Bounds);
        }
        if ((long)bounds.Width * bounds.Height > MaxComposedPixels) throw new PictureRefusedException("the run's windows cover too large an area");

        // Every box to cover, from every window's whole UI Automation tree (offscreen parts included).
        var boxes = new List<PixelRect>();
        var checkedCount = 0;
        foreach (var l in layers) CollectMasks(l.Window, texts, typedInto, boxes, ref checkedCount);

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

    private static void CollectMasks(IUiNode window, string[] texts, Func<string, bool> typedInto, List<PixelRect> boxes, ref int checkedCount)
    {
        // The window's own title is drawn in its title bar: a masked text there would need the whole window covered.
        if (Holds(window.Name, texts)) throw new PictureRefusedException("a window title shows a value the run masks");
        if (Redaction.HidesValue(window) || typedInto(window.Id)) throw new PictureRefusedException("a whole window would have to be covered");
        IReadOnlyList<IUiNode> all;
        try
        {
            // Every element of the window in one search; a window UI Automation cannot read throws here.
            all = window.FindDescendants(Cond.Any);
        }
        catch (ElementGoneException)
        {
            throw new PictureRefusedException("a window of the run cannot be read through UI Automation");
        }
        checkedCount += all.Count;
        if (checkedCount > MaxCheckedElements) throw new PictureRefusedException($"the run's windows hold more than {MaxCheckedElements} elements to check");
        foreach (var n in all)
        {
            var hides = Redaction.HidesValue(n);
            // A hidden value is never read; it is covered anyway.
            var cover = hides || typedInto(n.Id) || Holds(n.Name, texts) || Holds(n.Value, texts);
            if (!cover) continue;
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

    private static bool Holds(string? value, string[] texts) =>
        value is { Length: > 0 } && texts.Any(t => value.Contains(t, StringComparison.OrdinalIgnoreCase));
}
