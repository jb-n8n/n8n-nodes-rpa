namespace Rpa.Recorder.Core;

/// <summary>
/// Tells when Windows let input go past the recorder's low-level hooks. Windows may skip or silently remove a hook
/// that answers too slowly (an application screen that is slow to describe). Signs: input the system saw that the hooks
/// did not (<see cref="Lost"/>, against the time of the last input), or a mouse-down after a mouse-down with no
/// mouse-up between them. The recorder then reinstalls its hooks and says so on its bar, so a recording is not
/// silently incomplete. Input to a program that runs as administrator also goes past the hooks of a recorder that
/// does not. Times are milliseconds on one clock.
/// </summary>
public sealed class HookWatch
{
    /// <summary>How long input may go unseen by the hooks before they count as lost.</summary>
    public const long QuietMs = 1500;

    private long _lastSeen;
    private bool _downPending;

    /// <summary>A hook saw an event (any mouse or key event).</summary>
    public void Seen(long ms) => _lastSeen = Math.Max(_lastSeen, ms);

    /// <summary>A mouse button went down. True when the previous one never came up: its mouse-up was missed.</summary>
    public bool MouseDown(long ms)
    {
        var missed = _downPending;
        _downPending = true;
        Seen(ms);
        return missed;
    }

    public void MouseUp(long ms)
    {
        _downPending = false;
        Seen(ms);
    }

    /// <summary>Whether the system had input the hooks never saw, given the time of its last input.</summary>
    public bool Lost(long lastInputMs) => lastInputMs - _lastSeen > QuietMs;

    /// <summary>The hooks were installed again: what came before is forgotten.</summary>
    public void Reinstalled(long ms)
    {
        _lastSeen = ms;
        _downPending = false;
    }
}
