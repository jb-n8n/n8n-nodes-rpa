using System.Globalization;
using System.Text;

namespace Rpa.Supervisor.Core;

/// <summary>
/// What the Remote Desktop host process (RpaSupervisor.exe rdp-host) tells the service, one line per event on its
/// standard output:
/// <c>active &lt;sessionId&gt;</c> the bot user's session is Active;
/// <c>disconnected &lt;reason&gt; &lt;extended&gt; [description]</c> the connection ended, with the client's numbers;
/// <c>dialog &lt;text&gt;</c> the client showed a message box, which the host answered with its default button;
/// <c>failed &lt;text&gt;</c> the host could not go on;
/// <c>alive</c> every few seconds, so that the service can tell a hung host.
/// </summary>
public abstract record RdpHostEvent
{
    /// <summary>A text in a line is cut to this many characters.</summary>
    public const int MaxText = 500;

    public sealed record Active(uint SessionId) : RdpHostEvent;

    public sealed record Disconnected(int Reason, int Extended, string Description) : RdpHostEvent;

    public sealed record Dialog(string Text) : RdpHostEvent;

    public sealed record Failed(string Text) : RdpHostEvent;

    public sealed record Alive : RdpHostEvent;

    public string ToLine() => this switch
    {
        Active a => $"active {a.SessionId.ToString(CultureInfo.InvariantCulture)}",
        Disconnected d => $"disconnected {d.Reason.ToString(CultureInfo.InvariantCulture)} {d.Extended.ToString(CultureInfo.InvariantCulture)}"
            + (OneLine(d.Description) is { Length: > 0 } text ? " " + text : ""),
        Dialog d => "dialog " + OneLine(d.Text),
        Failed f => "failed " + OneLine(f.Text),
        Alive => "alive",
        _ => throw new InvalidOperationException(),
    };

    /// <summary>The event a line holds, or null when the line is not one.</summary>
    public static RdpHostEvent? Parse(string line)
    {
        var parts = line.Split(' ', 2);
        var rest = parts.Length > 1 ? parts[1] : "";
        switch (parts[0])
        {
            case "active":
                return uint.TryParse(rest, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? new Active(id) : null;
            case "disconnected":
                var numbers = rest.Split(' ', 3);
                if (numbers.Length < 2
                    || !int.TryParse(numbers[0], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var reason)
                    || !int.TryParse(numbers[1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var extended))
                    return null;
                return new Disconnected(reason, extended, numbers.Length > 2 ? numbers[2] : "");
            case "dialog":
                return new Dialog(rest);
            case "failed":
                return new Failed(rest);
            case "alive":
                return rest.Length == 0 ? new Alive() : null;
            default:
                return null;
        }
    }

    private static string OneLine(string text)
    {
        var builder = new StringBuilder(Math.Min(text.Length, MaxText));
        foreach (var c in text)
        {
            if (builder.Length == MaxText) break;
            builder.Append(char.IsControl(c) ? ' ' : c);
        }
        return builder.ToString().Trim();
    }
}
