using System.Net;

namespace Rpa.Recorder.Core;

/// <summary>What the bar does with a typed address: open it, ask first (an http address the login would cross a network
/// unencrypted to), or refuse it.</summary>
public enum AddressVerdict { Open, AskFirst, Refused }

/// <summary>A checked address: the verdict, the normalised address to open (null when refused) and what is wrong
/// (null unless refused).</summary>
public sealed record FormAddress(AddressVerdict Verdict, string? Target, string? Problem);

/// <summary>
/// The address of n8n's Import a bot form, for Open the import form after saving. The recorder uploads nothing and holds
/// no login: the bar opens the form in the default browser and puts the recording's path on the clipboard. It opens only
/// <see cref="FormAddress.Target"/> of an address that <see cref="Check"/> did not refuse: an https or http address,
/// normalised and escaped by <see cref="Uri"/>, never the typed text. The address is kept per Windows user, in the
/// recorder's folder beside the bar log.
/// </summary>
public static class ImportForm
{
    public const int MaxLength = 2048;
    private const string Empty = "Type the form's address.";
    private const string Scheme = "The address must start with https:// or http://.";
    private const string Characters = "The address may not hold spaces, line breaks or \\.";
    private const string Login = "Leave the login out of the address: the browser asks for it.";
    private const string TooLong = "The address is too long.";

    /// <summary><c>RPA Recorder\import-form.txt</c> in the user's local application data, or null when there is none.</summary>
    public static string? PathIn(string localAppData) => localAppData.Length == 0 ? null : Path.Combine(localAppData, "RPA Recorder", "import-form.txt");

    /// <summary>
    /// Opens <c>https://</c> addresses, and <c>http://</c> ones for this machine (<c>localhost</c>, <c>127.0.0.1</c>,
    /// <c>[::1]</c>) or a private network (10/8, 172.16/12, 192.168/16, a host name of one label). Asks first about
    /// any other <c>http://</c> address. Refuses everything else: another scheme, an address without <c>//</c>, a
    /// login in the address, spaces, control characters or a backslash anywhere. Spaces and line breaks around the
    /// address are left out.
    /// </summary>
    public static FormAddress Check(string typed)
    {
        var text = typed.Trim();
        if (text.Length == 0) return Refuse(Empty);
        if (text.Length > MaxLength) return Refuse(TooLong);
        if (text.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c == '\\')) return Refuse(Characters);
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || uri.IsUnc || uri.Host.Length == 0
            || !text.StartsWith(uri.Scheme + "://", StringComparison.OrdinalIgnoreCase))
            return Refuse(Scheme);
        var rest = text[(uri.Scheme.Length + 3)..];
        var end = rest.IndexOfAny(['/', '?', '#']);
        if (uri.UserInfo.Length > 0 || (end < 0 ? rest : rest[..end]).Contains('@')) return Refuse(Login);
        var target = uri.AbsoluteUri;
        if (!target.StartsWith("https://", StringComparison.Ordinal) && !target.StartsWith("http://", StringComparison.Ordinal)) return Refuse(Scheme);
        return new(uri.Scheme == "https" || IsLocal(uri) ? AddressVerdict.Open : AddressVerdict.AskFirst, target, null);
    }

    /// <summary>The kept address, checked again, or null when there is none, it cannot be read or it is refused now.</summary>
    public static FormAddress? Kept(string? path)
    {
        if (path is null) return null;
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length > MaxLength * 2) return null;
            var address = Check(File.ReadAllText(path));
            return address.Verdict == AddressVerdict.Refused ? null : address;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    }

    /// <summary>Keeps an address that is not refused, as its normalised form; false when it is refused or cannot be written.</summary>
    public static bool Keep(string? path, FormAddress address)
    {
        if (path is null || address is not { Verdict: not AddressVerdict.Refused, Target: { } target }) return false;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, target);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }

    private static FormAddress Refuse(string problem) => new(AddressVerdict.Refused, null, problem);

    private static bool IsLocal(Uri uri) => uri.HostNameType switch
    {
        UriHostNameType.Dns or UriHostNameType.Basic => !uri.Host.Contains('.'),
        UriHostNameType.IPv4 => IPAddress.Parse(uri.Host).GetAddressBytes() is [127, 0, 0, 1] or [10, _, _, _] or [172, >= 16 and <= 31, _, _] or [192, 168, _, _],
        UriHostNameType.IPv6 => IPAddress.TryParse(uri.DnsSafeHost, out var ip) && ip.Equals(IPAddress.IPv6Loopback),
        _ => false,
    };
}
