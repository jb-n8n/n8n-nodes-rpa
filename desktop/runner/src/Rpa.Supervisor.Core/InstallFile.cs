using System.Net;
using System.Text.Json;

namespace Rpa.Supervisor.Core;

/// <summary>
/// The fields of install.json the RPA Supervisor reads. The installer writes the file; it uses these names. The proxy
/// listens on runnerPort and passes connections to runnerInnerPort on 127.0.0.1, where the runner listens in the bot
/// user's session; the same for browserPort and browserInnerPort when browserPort is there.
/// </summary>
public static class InstallFile
{
    public const string Mode = "mode";
    public const string User = "user";
    public const string RunnerPort = "runnerPort";
    public const string BrowserPort = "browserPort";
    public const string RunnerInnerPort = "runnerInnerPort";
    public const string BrowserInnerPort = "browserInnerPort";
    public const string IdleSeconds = "idleSeconds";
    public const string ListenAddresses = "listenAddresses";

    /// <summary>The value of mode that makes the supervisor run; with any other the service does nothing.</summary>
    public const string Unattended = "unattended";

    private const int MaxIdleSeconds = 86400;
    // What a local Windows user name may not hold (and @, which would make it read as a domain user).
    private static readonly char[] NotInUserName = ['"', '/', '\\', '[', ']', ':', ';', '|', '=', ',', '+', '*', '?', '<', '>', '@'];

    /// <summary>The supervisor's options from install.json's text, or null when mode is not unattended. Throws
    /// InvalidDataException, naming the field, when a field is missing or wrong. user may be written name, .\name or
    /// machineName\name; the options hold the name alone.</summary>
    public static SupervisorOptions? ToOptions(string json, string stateFile, string machineName)
    {
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(json);
            root = document.RootElement.Clone();
        }
        catch (JsonException e)
        {
            throw new InvalidDataException($"install.json is not valid JSON: {e.Message}");
        }
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("install.json is not a JSON object.");
        if (!root.TryGetProperty(Mode, out var mode) || mode.ValueKind != JsonValueKind.String || mode.GetString() != Unattended)
            return null;

        var user = root.TryGetProperty(User, out var u) && u.ValueKind == JsonValueKind.String ? u.GetString()! : "";
        if (user.Split('\\') is [var prefix, var name]
            && (prefix == "." || string.Equals(prefix, machineName, StringComparison.OrdinalIgnoreCase)))
            user = name;
        if (user.Length is 0 or > 20 || user.Trim(' ', '.').Length == 0 || user.IndexOfAny(NotInUserName) >= 0 || user.Any(char.IsControl))
            throw Wrong($"{User} must name a local Windows user of this machine: name, .\\name or {machineName}\\name, the name at most 20 characters.");

        var ports = new List<PortMap> { new(Port(root, RunnerPort), Port(root, RunnerInnerPort)) };
        if (root.TryGetProperty(BrowserPort, out var browser) && browser.ValueKind != JsonValueKind.Null)
            ports.Add(new PortMap(Port(root, BrowserPort), Port(root, BrowserInnerPort)));
        var all = ports.SelectMany(p => new[] { p.ListenPort, p.TargetPort }).ToArray();
        if (all.Distinct().Count() != all.Length)
            throw Wrong("the ports the RPA Supervisor listens on and the ports it passes connections to must all be different.");

        int? idleSeconds = null;
        if (root.TryGetProperty(IdleSeconds, out var idle))
        {
            if (idle.ValueKind != JsonValueKind.Number || !idle.TryGetInt32(out var seconds) || seconds is < 0 or > MaxIdleSeconds)
                throw Wrong($"{IdleSeconds} must be a whole number from 0 to {MaxIdleSeconds}.");
            idleSeconds = seconds;
        }

        List<string> addresses = ["0.0.0.0"];
        if (root.TryGetProperty(ListenAddresses, out var listen))
        {
            if (listen.ValueKind != JsonValueKind.Array || listen.GetArrayLength() == 0
                || listen.EnumerateArray().Any(a => a.ValueKind != JsonValueKind.String || !IPAddress.TryParse(a.GetString(), out _)))
                throw Wrong($"{ListenAddresses} must be a list of IP addresses.");
            addresses = listen.EnumerateArray().Select(a => a.GetString()!).ToList();
        }

        var options = new SupervisorOptions(user, ports, addresses, StateFile: stateFile);
        return idleSeconds is { } value ? options with { IdleSeconds = value } : options;
    }

    private static int Port(JsonElement root, string name)
    {
        if (root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var port)
            && port is >= 1 and <= 65535)
            return port;
        throw Wrong($"{name} must be a port number from 1 to 65535.");
    }

    private static InvalidDataException Wrong(string message) => new($"install.json: {message}");
}
