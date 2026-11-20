using System.Globalization;
using System.Text;

namespace Rpa.Supervisor.Core;

/// <summary>
/// What the Remote Desktop host process (RpaSupervisor.exe rdp-host) tells the service, one line per event on its
/// standard output:
/// <c>active &lt;sessionId&gt;</c> the bot user's session is Active;
/// <c>disconnected &lt;reason&gt; &lt;extended&gt; [description]</c> the connection ended, with the client's numbers;
/// <c>dialog button|closed &lt;text&gt;</c> the client showed a message box, which the host answered with its default
/// button, or closed when it found none;
/// <c>logon-error &lt;code&gt;</c> and <c>warning &lt;code&gt;</c> the client's logon errors (other than -2, "logon goes
/// on") and warnings;
/// <c>failed &lt;text&gt;</c> the host could not go on;
/// <c>alive</c> every few seconds, so that the service can tell a hung host.
/// </summary>
public abstract record RdpHostEvent
{
    /// <summary>A text in a line is cut to this many characters.</summary>
    public const int MaxText = 500;

    public sealed record Active(uint SessionId) : RdpHostEvent;

    public sealed record Disconnected(int Reason, int Extended, string Description) : RdpHostEvent;

    public sealed record Dialog(bool Pressed, string Text) : RdpHostEvent;

    public sealed record LogonError(int Code) : RdpHostEvent;

    public sealed record Warning(int Code) : RdpHostEvent;

    public sealed record Failed(string Text) : RdpHostEvent;

    public sealed record Alive : RdpHostEvent;

    public string ToLine() => this switch
    {
        Active a => $"active {a.SessionId.ToString(CultureInfo.InvariantCulture)}",
        Disconnected d => $"disconnected {d.Reason.ToString(CultureInfo.InvariantCulture)} {d.Extended.ToString(CultureInfo.InvariantCulture)}"
            + (OneLine(d.Description) is { Length: > 0 } text ? " " + text : ""),
        Dialog d => (d.Pressed ? "dialog button " : "dialog closed ") + OneLine(d.Text),
        LogonError e => $"logon-error {e.Code.ToString(CultureInfo.InvariantCulture)}",
        Warning w => $"warning {w.Code.ToString(CultureInfo.InvariantCulture)}",
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
                var answer = rest.Split(' ', 2);
                return answer[0] is "button" or "closed" ? new Dialog(answer[0] == "button", answer.Length > 1 ? answer[1] : "") : null;
            case "logon-error":
                return Number(rest) is { } error ? new LogonError(error) : null;
            case "warning":
                return Number(rest) is { } warning ? new Warning(warning) : null;
            case "failed":
                return new Failed(rest);
            case "alive":
                return rest.Length == 0 ? new Alive() : null;
            default:
                return null;
        }
    }

    private static int? Number(string text) =>
        int.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var code) ? code : null;

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
