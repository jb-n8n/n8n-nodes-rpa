using System.Drawing;

namespace Rpa.Recorder.Core;

/// <summary>
/// The bar's size, its spacing scale and where its windows open. Sizes are at 100 % (96 DPI); the window code scales
/// them for the screen. The bar opens at the top right of the screen; a question opens beside it, so that the list it
/// is about stays in view.
/// </summary>
public static class BarLayout
{
    public const int Width = 420, Height = 600, MinWidth = 360, MinHeight = 440;

    /// <summary>The spacing scale: between lines of one group, between controls, between groups and at the edges.</summary>
    public const int Tight = 4, Space = 8, Group = 12, Edge = 12;

    /// <summary>The width of a question's text.</summary>
    public const int DialogWidth = 400;

    /// <summary>The bar's starting width for a working area this wide (both at 100 %): narrower below 1280, where it
    /// would cover much of the app.</summary>
    public static int WidthFor(int areaWidth) => areaWidth < 1280 ? MinWidth : Width;

    /// <summary>
    /// The bar grown downward so that its list is <paramref name="needed"/> high when it is <paramref name="list"/>
    /// high now: at most to the bottom of the working area, and never smaller than it is.
    /// </summary>
    public static Rectangle GrowForList(Rectangle bar, int list, int needed, Rectangle area)
    {
        var height = Math.Max(bar.Height, Math.Min(bar.Height + Math.Max(0, needed - list), area.Bottom - bar.Top));
        return bar with { Height = height };
    }

    /// <summary>The bar at the top right of the working area, <paramref name="gap"/> from its edges, and no larger than
    /// the working area allows.</summary>
    public static Rectangle Initial(Rectangle area, Size size, int gap)
    {
        var width = Math.Min(size.Width, area.Width - 2 * gap);
        var height = Math.Min(size.Height, area.Height - 2 * gap);
        return new Rectangle(area.Right - width - gap, area.Top + gap, width, height);
    }

    /// <summary>A question beside the bar: to its left when there is room, else to its right, else as far left as the
    /// working area goes. Its top is the bar's, kept inside the working area.</summary>
    public static Point Beside(Rectangle bar, Size dialog, Rectangle area, int gap)
    {
        var left = bar.Left - gap - dialog.Width;
        var right = bar.Right + gap;
        var x = left >= area.Left ? left : right + dialog.Width <= area.Right ? right : Math.Max(area.Left, Math.Min(left, area.Right - dialog.Width));
        var y = Math.Max(area.Top, Math.Min(bar.Top, area.Bottom - dialog.Height));
        return new Point(x, y);
    }
}
