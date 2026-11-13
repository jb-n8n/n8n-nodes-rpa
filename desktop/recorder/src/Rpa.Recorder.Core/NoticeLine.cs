using System.Globalization;

namespace Rpa.Recorder.Core;

/// <summary>How a notice is shown: amber when the person should check something, plain when it only informs.</summary>
public enum NoticeTone { Information, Check }

/// <summary>A notice on the bar. Its text may name a step's element; it never holds typed text.</summary>
public sealed record BarNotice(DateTimeOffset At, string Text, NoticeTone Tone);

/// <summary>
/// The bar's notice line: one line between the state line and the list, the newest notice replacing the one before.
/// The earlier ones are kept (newest first, at most <see cref="MaxKept"/> in all) for the "Earlier notices" list. A notice
/// that says the same as the one shown only takes its time.
/// </summary>
public sealed class NoticeLine
{
    public const int MaxKept = 100;
    private readonly List<BarNotice> _all = [];

    public BarNotice? Current => _all.Count > 0 ? _all[0] : null;

    /// <summary>Every notice kept, newest first: the list behind the link, where the one on the line (which may be cut)
    /// can be read whole.</summary>
    public IReadOnlyList<BarNotice> All => _all.ToArray();

    /// <summary>The link to the earlier notices, or null when there are none.</summary>
    public string? EarlierLink => _all.Count > 1 ? $"{DialogText.NoticesTitle} ({_all.Count - 1})" : null;

    public void Add(BarNotice notice)
    {
        if (_all.Count > 0 && _all[0].Text == notice.Text && _all[0].Tone == notice.Tone) _all.RemoveAt(0);
        _all.Insert(0, notice);
        if (_all.Count > MaxKept) _all.RemoveAt(_all.Count - 1);
    }

    public void Clear() => _all.Clear();

    public static NoticeTone Tone(NoticeKind kind) => kind == NoticeKind.OtherProgram ? NoticeTone.Information : NoticeTone.Check;

    /// <summary>A notice as the list of earlier notices shows it: its time, then its text.</summary>
    public static string Listed(BarNotice notice) => $"{notice.At.ToString("HH:mm:ss", CultureInfo.InvariantCulture)}  {notice.Text}";
}
