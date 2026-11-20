using System.Buffers.Binary;
using System.IO.Compression;

namespace Rpa.Runner.Core.Ui;

/// <summary>A rectangle in screen pixels (physical pixels: the runner is per-monitor DPI aware).</summary>
public readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;
    public int Bottom => Y + Height;
    public bool IsEmpty => Width <= 0 || Height <= 0;

    public PixelRect Intersect(PixelRect o)
    {
        var x = Math.Max(X, o.X);
        var y = Math.Max(Y, o.Y);
        var r = Math.Min(Right, o.Right);
        var b = Math.Min(Bottom, o.Bottom);
        return r <= x || b <= y ? default : new PixelRect(x, y, r - x, b - y);
    }

    public PixelRect Union(PixelRect o)
    {
        if (IsEmpty) return o;
        if (o.IsEmpty) return this;
        var x = Math.Min(X, o.X);
        var y = Math.Min(Y, o.Y);
        return new PixelRect(x, y, Math.Max(Right, o.Right) - x, Math.Max(Bottom, o.Bottom) - y);
    }

    public PixelRect Inflate(int by) => new(X - by, Y - by, Width + 2 * by, Height + 2 * by);

    public bool Overlaps(PixelRect o) => !Intersect(o).IsEmpty;
}

/// <summary>
/// One top-level window's own pixels (PrintWindow: not what overlaps it), 32-bit BGRA rows top to bottom, with the
/// processes that own its child windows (a child window of another process would be drawn into the capture).
/// <paramref name="DpiScaled"/>: Windows scales the window's drawing (a DPI-unaware or system-aware window on a monitor of
/// another DPI), so its pixels may not line up with UI Automation's coordinates.
/// </summary>
public sealed record WindowCapture(PixelRect Bounds, byte[] Bgra, IReadOnlyList<int> ChildProcessIds, bool DpiScaled = false);

/// <summary>
/// An RGB picture for the repair's screenshot, platform-neutral so it is tested anywhere: compose windows on black, fill
/// rectangles, shrink, draw number labels, encode PNG. Nothing here reads the screen.
/// </summary>
public sealed class Raster
{
    public Raster(int width, int height)
    {
        if (width <= 0 || height <= 0) throw new ArgumentOutOfRangeException(nameof(width), "a picture needs at least one pixel");
        Width = width;
        Height = height;
        Rgb = new byte[checked(width * height * 3)];
    }

    public int Width { get; }
    public int Height { get; }

    /// <summary>Row-major RGB, 3 bytes per pixel. Starts black.</summary>
    public byte[] Rgb { get; }

    public (byte R, byte G, byte B) Pixel(int x, int y)
    {
        var i = (y * Width + x) * 3;
        return (Rgb[i], Rgb[i + 1], Rgb[i + 2]);
    }

    /// <summary>Copies a window's BGRA pixels with its top-left corner at (ox, oy); what falls outside is dropped.</summary>
    public void Blit(byte[] bgra, int width, int height, int ox, int oy)
    {
        if (bgra.Length < width * height * 4) throw new ArgumentException("the capture is smaller than its size says", nameof(bgra));
        for (var y = 0; y < height; y++)
        {
            var ty = oy + y;
            if (ty < 0 || ty >= Height) continue;
            for (var x = 0; x < width; x++)
            {
                var tx = ox + x;
                if (tx < 0 || tx >= Width) continue;
                var s = (y * width + x) * 4;
                var d = (ty * Width + tx) * 3;
                Rgb[d] = bgra[s + 2];
                Rgb[d + 1] = bgra[s + 1];
                Rgb[d + 2] = bgra[s];
            }
        }
    }

    /// <summary>An opaque fill, clipped to the picture.</summary>
    public void Fill(PixelRect r, byte red, byte green, byte blue)
    {
        var c = r.Intersect(new PixelRect(0, 0, Width, Height));
        if (c.IsEmpty) return;
        for (var y = c.Y; y < c.Bottom; y++)
        {
            for (var x = c.X; x < c.Right; x++)
            {
                var d = (y * Width + x) * 3;
                Rgb[d] = red;
                Rgb[d + 1] = green;
                Rgb[d + 2] = blue;
            }
        }
    }

    /// <summary>The picture shrunk so its longer side is at most <paramref name="maxEdge"/> (area average), or itself.</summary>
    public Raster ShrinkTo(int maxEdge, out double scale)
    {
        var longer = Math.Max(Width, Height);
        if (longer <= maxEdge)
        {
            scale = 1;
            return this;
        }
        scale = (double)maxEdge / longer;
        var w = Math.Max(1, (int)Math.Round(Width * scale));
        var h = Math.Max(1, (int)Math.Round(Height * scale));
        var o = new Raster(w, h);
        for (var y = 0; y < h; y++)
        {
            var y0 = (int)((long)y * Height / h);
            var y1 = Math.Max(y0 + 1, (int)((long)(y + 1) * Height / h));
            for (var x = 0; x < w; x++)
            {
                var x0 = (int)((long)x * Width / w);
                var x1 = Math.Max(x0 + 1, (int)((long)(x + 1) * Width / w));
                long r = 0, g = 0, b = 0, n = 0;
                for (var sy = y0; sy < y1; sy++)
                {
                    for (var sx = x0; sx < x1; sx++)
                    {
                        var s = (sy * Width + sx) * 3;
                        r += Rgb[s];
                        g += Rgb[s + 1];
                        b += Rgb[s + 2];
                        n++;
                    }
                }
                var d = (y * w + x) * 3;
                o.Rgb[d] = (byte)(r / n);
                o.Rgb[d + 1] = (byte)(g / n);
                o.Rgb[d + 2] = (byte)(b / n);
            }
        }
        return o;
    }

    // Digits 0-9, 5 columns by 7 rows, one row per byte (bit 4 = left column).
    private static readonly byte[][] Digits =
    [
        [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
    ];

    /// <summary>Label scale: each font pixel is this many picture pixels (digits 10 by 14).</summary>
    public const int LabelScale = 2;

    /// <summary>The size of a number label: digits with one font pixel between them, a padding of 2 and a 1-pixel border.</summary>
    public static (int W, int H) LabelSize(string digits) =>
        (digits.Length * 6 * LabelScale - LabelScale + 6, 7 * LabelScale + 6);

    /// <summary>A number label (black digits on yellow, black border) with its top-left corner at (x, y). Digits only.</summary>
    public void DrawLabel(string digits, int x, int y)
    {
        if (digits.Length == 0 || digits.Any(c => c is < '0' or > '9')) throw new ArgumentException("a label holds digits only", nameof(digits));
        var (w, h) = LabelSize(digits);
        Fill(new PixelRect(x, y, w, h), 0, 0, 0);
        Fill(new PixelRect(x + 1, y + 1, w - 2, h - 2), 255, 230, 0);
        var cx = x + 3;
        foreach (var ch in digits)
        {
            var glyph = Digits[ch - '0'];
            for (var row = 0; row < 7; row++)
            {
                for (var col = 0; col < 5; col++)
                {
                    if ((glyph[row] & (0x10 >> col)) == 0) continue;
                    Fill(new PixelRect(cx + col * LabelScale, y + 3 + row * LabelScale, LabelScale, LabelScale), 0, 0, 0);
                }
            }
            cx += 6 * LabelScale;
        }
    }

    /// <summary>The picture as an 8-bit RGB PNG (each row filtered None, Sub or Up, whichever is smallest).</summary>
    public byte[] EncodePng()
    {
        var stride = Width * 3;
        var raw = new byte[(stride + 1) * Height];
        var cand = new byte[3][];
        for (var k = 0; k < 3; k++) cand[k] = new byte[stride];
        for (var y = 0; y < Height; y++)
        {
            var row = y * stride;
            var prev = (y - 1) * stride;
            for (var i = 0; i < stride; i++)
            {
                var v = Rgb[row + i];
                cand[0][i] = v;
                cand[1][i] = (byte)(v - (i >= 3 ? Rgb[row + i - 3] : 0));
                cand[2][i] = (byte)(v - (y > 0 ? Rgb[prev + i] : 0));
            }
            var best = 0;
            long bestSum = long.MaxValue;
            for (var k = 0; k < 3; k++)
            {
                long sum = 0;
                foreach (var b in cand[k]) sum += b < 128 ? b : 256 - b;
                if (sum < bestSum)
                {
                    bestSum = sum;
                    best = k;
                }
            }
            var at = y * (stride + 1);
            raw[at] = (byte)best;
            Buffer.BlockCopy(cand[best], 0, raw, at + 1, stride);
        }
        using var idat = new MemoryStream();
        using (var z = new ZLibStream(idat, CompressionLevel.Optimal, leaveOpen: true)) z.Write(raw);

        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, Width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), Height);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 2; // RGB
        Chunk(png, "IHDR", ihdr);
        Chunk(png, "IDAT", idat.ToArray());
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] data)
    {
        Span<byte> len = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        s.Write(len);
        var t = System.Text.Encoding.ASCII.GetBytes(type);
        s.Write(t);
        s.Write(data);
        var crc = Crc32(t, data);
        Span<byte> c = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(c, crc);
        s.Write(c);
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var t = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }

    private static uint Crc32(byte[] a, byte[] b)
    {
        var c = 0xFFFFFFFFu;
        foreach (var x in a) c = CrcTable[(c ^ x) & 0xFF] ^ (c >> 8);
        foreach (var x in b) c = CrcTable[(c ^ x) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
}
