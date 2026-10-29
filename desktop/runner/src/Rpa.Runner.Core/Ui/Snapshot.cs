using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Ui;

/// <summary>Which values the runner never returns: password fields and fields with credential-like names.</summary>
public static partial class Redaction
{
    [GeneratedRegex(
        @"password|passwort|passwd|passcode|passphrase|\bpass\b|pwd|kennwort|contrase|mot\s*de\s*passe|secret|token|credential|api[\s_-]?key|\bpin\b|\botp\b|one[\s-]?time|\b2fa\b|\bmfa\b|\bcvv\b|\bcvc\b|security\s*code",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CredentialLike();

    public static bool IsCredentialLike(string? text) => !string.IsNullOrEmpty(text) && CredentialLike().IsMatch(text);

    /// <summary>True when an element's value must not leave the runner.</summary>
    public static bool HidesValue(IUiNode node) =>
        node.IsPassword || IsCredentialLike(node.Name) || IsCredentialLike(node.AutomationId);
}

public sealed record SnapshotNode(
    [property: JsonPropertyName("ref")] string Ref,
    [property: JsonPropertyName("depth")] int Depth,
    [property: JsonPropertyName("controlType")] string ControlType,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("automationId")] string AutomationId,
    [property: JsonPropertyName("className")] string ClassName,
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("value"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value,
    [property: JsonPropertyName("valueHidden"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? ValueHidden);

/// <summary>
/// A pruned tree of one window, depth first in document order: offscreen subtrees are left out, and unnamed layout
/// containers (Pane, Group, Custom with no name and no automation id) are flattened into their parent. Stops at
/// <c>maxNodes</c> emitted nodes and at <c>maxDepth</c> levels of the real tree.
/// </summary>
public static class SnapshotBuilder
{
    public const int MaxValueLength = 500;

    private static readonly HashSet<string> Flattenable = new(StringComparer.OrdinalIgnoreCase) { "Pane", "Group", "Custom" };

    public sealed record Result(IReadOnlyList<SnapshotNode> Nodes, bool Truncated);

    public static Result Build(IUiNode window, int maxNodes, int maxDepth)
    {
        var nodes = new List<SnapshotNode>();
        var truncated = false;
        Visit(window, realDepth: 0, depth: 0, root: true);
        return new Result(nodes, truncated);

        void Visit(IUiNode n, int realDepth, int depth, bool root)
        {
            if (nodes.Count >= maxNodes)
            {
                truncated = true;
                return;
            }
            bool offscreen, emit;
            try
            {
                offscreen = !root && n.IsOffscreen;
                if (offscreen) return;
                emit = root || !(Flattenable.Contains(n.ControlType) && n.Name.Length == 0 && n.AutomationId.Length == 0);
                if (emit) nodes.Add(ToNode(n, $"n{nodes.Count}", depth));
            }
            catch (ElementGoneException)
            {
                return;
            }
            if (realDepth >= maxDepth)
            {
                if (SafeHasChildren(n)) truncated = true;
                return;
            }
            IReadOnlyList<IUiNode> children;
            try { children = n.GetChildren(); }
            catch (ElementGoneException) { return; }
            foreach (var c in children)
            {
                Visit(c, realDepth + 1, emit ? depth + 1 : depth, root: false);
                if (nodes.Count >= maxNodes)
                {
                    truncated = true;
                    return;
                }
            }
        }
    }

    private static bool SafeHasChildren(IUiNode n)
    {
        try { return n.GetChildren().Count > 0; }
        catch (ElementGoneException) { return false; }
    }

    private static SnapshotNode ToNode(IUiNode n, string reference, int depth)
    {
        string? value = null;
        bool? hidden = null;
        if (Redaction.HidesValue(n))
        {
            hidden = true;
        }
        else
        {
            value = n.Value;
            if (value is { Length: > MaxValueLength }) value = value[..MaxValueLength];
        }
        return new SnapshotNode(reference, depth, n.ControlType, n.Name, n.AutomationId, n.ClassName, n.IsEnabled, value, hidden);
    }
}
