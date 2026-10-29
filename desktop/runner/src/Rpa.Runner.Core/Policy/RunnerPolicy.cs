using System.Text.Json;
using System.Text.Json.Serialization;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Policy;

/// <summary>
/// The local policy file (the floor n8n cannot lower): allowed applications, write controls, gated keys and the file
/// size limit. Read once at start. Unknown fields are refused so a misspelt key cannot silently switch a check off.
/// </summary>
public sealed class RunnerPolicy
{
    public const long DefaultMaxFileBytes = 20 * 1024 * 1024;

    public IReadOnlyList<AllowedApp> AllowedApps { get; init; } = [];
    public IReadOnlyList<WriteControl> WriteControls { get; init; } = [];
    public IReadOnlyList<KeyChord> GatedKeys { get; init; } = [];
    public long MaxFileBytes { get; init; } = DefaultMaxFileBytes;

    /// <summary>
    /// An application app.launch may start. <c>exe</c> is the file name that app.launch requests and window checks match
    /// (case-insensitive). The fields beyond the contract's example are required or optional as follows:
    /// <c>path</c> (required) pins the absolute local path, the only file launched for this entry (never a UNC or device
    /// path); <c>sha256</c> (optional) pins the file's hash; <c>allowedArgs</c> (optional) lists the exact argument lists
    /// app.launch may pass (none otherwise); <c>allowUserWritable</c> (optional, default false) permits a path the
    /// runner's own user can modify (otherwise refused, since anything the runner user can replace is not pinned).
    /// </summary>
    public sealed record AllowedApp(string Exe, string Path, string? Sha256, IReadOnlyList<IReadOnlyList<string>> AllowedArgs, bool AllowUserWritable);

    public sealed record WriteControl(string Exe, string AutomationId);

    private sealed class FileShape
    {
        public List<AppShape>? AllowedApps { get; set; }
        public List<WriteShape>? WriteControls { get; set; }
        public List<string>? GatedKeys { get; set; }
        public long? MaxFileBytes { get; set; }
    }

    private sealed class AppShape
    {
        public string? Exe { get; set; }
        public string? Path { get; set; }
        public string? Sha256 { get; set; }
        public List<List<string>>? AllowedArgs { get; set; }
        public bool? AllowUserWritable { get; set; }
    }

    private sealed class WriteShape
    {
        public string? Exe { get; set; }
        public string? AutomationId { get; set; }
    }

    private static readonly JsonSerializerOptions FileOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    /// <summary>Thrown for a policy file the runner refuses to start with.</summary>
    public sealed class InvalidPolicyException(string message) : Exception(message);

    public static RunnerPolicy Load(string path)
    {
        if (!File.Exists(path)) throw new InvalidPolicyException($"policy file not found: {path}");
        return Parse(File.ReadAllText(path), path);
    }

    public static RunnerPolicy Parse(string json, string source = "policy")
    {
        FileShape shape;
        try
        {
            shape = JsonSerializer.Deserialize<FileShape>(json, FileOptions)
                    ?? throw new InvalidPolicyException($"{source}: empty policy");
        }
        catch (JsonException e)
        {
            throw new InvalidPolicyException($"{source}: {e.Message}");
        }

        var apps = new List<AllowedApp>();
        foreach (var a in shape.AllowedApps ?? [])
        {
            if (string.IsNullOrWhiteSpace(a.Exe) || a.Exe.IndexOfAny(['\\', '/']) >= 0)
                throw new InvalidPolicyException($"{source}: allowedApps[].exe must be a file name such as \"App.exe\"");
            if (a.Path is null)
                throw new InvalidPolicyException($"{source}: allowedApps[].path is required (the absolute path of {a.Exe})");
            if (IsUncOrDevice(a.Path) || !System.IO.Path.IsPathFullyQualified(a.Path))
                throw new InvalidPolicyException($"{source}: allowedApps[].path must be an absolute local path (no UNC or device paths)");
            if (!string.Equals(System.IO.Path.GetFileName(a.Path), a.Exe, StringComparison.OrdinalIgnoreCase))
                throw new InvalidPolicyException($"{source}: allowedApps[].path must end in the exe file name");
            if (a.Sha256 is not null && !System.Text.RegularExpressions.Regex.IsMatch(a.Sha256, "^[0-9a-fA-F]{64}$"))
                throw new InvalidPolicyException($"{source}: allowedApps[].sha256 must be 64 hex characters");
            var argLists = (a.AllowedArgs ?? []).Select(l => (IReadOnlyList<string>)(l ?? throw new InvalidPolicyException($"{source}: allowedApps[].allowedArgs must be a list of string lists"))).ToList();
            apps.Add(new AllowedApp(a.Exe, System.IO.Path.GetFullPath(a.Path), a.Sha256?.ToUpperInvariant(), argLists, a.AllowUserWritable ?? false));
        }

        var writes = new List<WriteControl>();
        foreach (var w in shape.WriteControls ?? [])
        {
            if (string.IsNullOrWhiteSpace(w.Exe) || string.IsNullOrEmpty(w.AutomationId))
                throw new InvalidPolicyException($"{source}: writeControls[] needs exe and automationId");
            writes.Add(new WriteControl(w.Exe, w.AutomationId));
        }

        var keys = new List<KeyChord>();
        foreach (var k in shape.GatedKeys ?? [])
        {
            try { keys.Add(KeyChord.Parse(k)); }
            catch (RpcException) { throw new InvalidPolicyException($"{source}: gatedKeys has an invalid key chord \"{k}\""); }
        }

        var max = shape.MaxFileBytes ?? DefaultMaxFileBytes;
        if (max <= 0) throw new InvalidPolicyException($"{source}: maxFileBytes must be positive");

        return new RunnerPolicy { AllowedApps = apps, WriteControls = writes, GatedKeys = keys, MaxFileBytes = max };
    }

    public bool IsAllowedExe(string? exeName) =>
        exeName is not null && AllowedApps.Any(a => string.Equals(a.Exe, exeName, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The policy entry app.launch may start for the requested exe and arguments, or a policy refusal. The request names
    /// the file name or the entry's exact path; the entry's pinned path is what runs. Several entries may name the same
    /// exe with different paths.
    /// </summary>
    public AllowedApp ResolveLaunch(string requested, IReadOnlyList<string> args)
    {
        var name = System.IO.Path.GetFileName(requested);
        var apps = AllowedApps.Where(a => string.Equals(a.Exe, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (apps.Count == 0) throw RpcErrors.PolicyRefused($"application \"{name}\" is not in the runner's allowedApps");
        AllowedApp app;
        if (string.Equals(requested, name, StringComparison.Ordinal))
        {
            app = apps[0];
        }
        else
        {
            if (IsUncOrDevice(requested) || !System.IO.Path.IsPathFullyQualified(requested))
                throw RpcErrors.PolicyRefused($"application \"{name}\" must be named by its file name or the absolute local path in the policy");
            var full = System.IO.Path.GetFullPath(requested);
            app = apps.FirstOrDefault(a => string.Equals(a.Path, full, StringComparison.OrdinalIgnoreCase))
                  ?? throw RpcErrors.PolicyRefused($"application \"{name}\" may only be started from the paths the policy names");
        }
        if (args.Count > 0 && !app.AllowedArgs.Any(l => l.SequenceEqual(args, StringComparer.Ordinal)))
            throw RpcErrors.PolicyRefused($"these arguments for \"{name}\" are not in the policy's allowedArgs");
        return app;
    }

    /// <summary>UNC (\\server\share), device (\\.\, \\?\) and forward-slash variants.</summary>
    public static bool IsUncOrDevice(string path) =>
        path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal) ||
        path.StartsWith(@"\/", StringComparison.Ordinal) || path.StartsWith(@"/\", StringComparison.Ordinal);

    public bool IsWriteControl(string? exeName, string automationId) =>
        exeName is not null && automationId.Length > 0 && WriteControls.Any(w =>
            string.Equals(w.Exe, exeName, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(w.AutomationId, automationId, StringComparison.Ordinal));

    public bool IsGatedKey(KeyChord chord) => GatedKeys.Contains(chord);
}
