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
    /// <c>exe</c> is the file name app.launch and window checks match (case-insensitive). <c>path</c> (optional, an
    /// extension to the contract's example) pins the absolute path: app.launch then launches exactly that file. Without
    /// <c>path</c>, app.launch must give an absolute path whose file name is <c>exe</c>.
    /// </summary>
    public sealed record AllowedApp(string Exe, string? Path);

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
            if (a.Path is not null)
            {
                if (!System.IO.Path.IsPathFullyQualified(a.Path))
                    throw new InvalidPolicyException($"{source}: allowedApps[].path must be an absolute path");
                if (!string.Equals(System.IO.Path.GetFileName(a.Path), a.Exe, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidPolicyException($"{source}: allowedApps[].path must end in the exe file name");
            }
            apps.Add(new AllowedApp(a.Exe, a.Path is null ? null : System.IO.Path.GetFullPath(a.Path)));
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
    /// The file app.launch may start for the requested exe, or a policy refusal. Never launches a bare name from the
    /// working directory or PATH. Several entries may name the same exe with different paths.
    /// </summary>
    public string ResolveLaunch(string requested)
    {
        var name = System.IO.Path.GetFileName(requested);
        var apps = AllowedApps.Where(a => string.Equals(a.Exe, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (apps.Count == 0) throw RpcErrors.PolicyRefused($"application \"{name}\" is not in the runner's allowedApps");
        if (string.Equals(requested, name, StringComparison.Ordinal))
        {
            return apps.FirstOrDefault(a => a.Path is not null)?.Path
                   ?? throw RpcErrors.PolicyRefused($"application \"{name}\" needs an absolute path (or a path in the runner's policy)");
        }
        if (!System.IO.Path.IsPathFullyQualified(requested))
            throw RpcErrors.PolicyRefused($"application \"{name}\" needs an absolute path (or a path in the runner's policy)");
        var full = System.IO.Path.GetFullPath(requested);
        var pinned = apps.FirstOrDefault(a => a.Path is not null && string.Equals(a.Path, full, StringComparison.OrdinalIgnoreCase));
        if (pinned is not null) return pinned.Path!;
        if (apps.Any(a => a.Path is null)) return full;
        throw RpcErrors.PolicyRefused($"application \"{name}\" may only be started from the paths the policy names");
    }

    public bool IsWriteControl(string? exeName, string automationId) =>
        exeName is not null && automationId.Length > 0 && WriteControls.Any(w =>
            string.Equals(w.Exe, exeName, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(w.AutomationId, automationId, StringComparison.Ordinal));

    public bool IsGatedKey(KeyChord chord) => GatedKeys.Contains(chord);
}
