using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Runs;

namespace Rpa.Runner.Core.Ui;

/// <summary>A resolved target: which candidate won (0 = primary), the element and its top-level window.</summary>
public sealed record Resolution(int Candidate, IUiNode Element, IUiNode Window);

/// <summary>
/// The contract's target semantics. A target's path is matched as descendants in order (each condition searched among
/// the descendants of the previous matches, starting from the run's windows that match the target's window selector);
/// <c>index</c> picks the n-th among siblings (same parent) that match the rest. The first of primary and fallbacks that
/// matches exactly one visible element wins.
/// </summary>
public sealed class TargetResolver
{
    private readonly WindowScope _scope;
    private readonly TimeProvider _time;

    public TargetResolver(WindowScope scope, TimeProvider time)
    {
        _scope = scope;
        _time = time;
    }

    public static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>Polls until a candidate wins or the timeout passes, then throws not_found or not_unique.</summary>
    public Resolution Resolve(RunState run, Target target, TimeSpan timeout, CancellationToken ct = default)
    {
        var deadline = _time.GetUtcNow() + timeout;
        while (true)
        {
            var attempt = TryResolve(run, target);
            if (attempt.Winner is not null) return attempt.Winner;
            if (_time.GetUtcNow() >= deadline) throw attempt.Failure();
            ct.ThrowIfCancellationRequested();
            Thread.Sleep(PollInterval);
        }
    }

    /// <summary>One attempt, no waiting.</summary>
    public Attempt TryResolve(RunState run, Target target)
    {
        var candidates = new List<Target> { target };
        candidates.AddRange(target.Fallbacks);
        int primaryCount = 0;
        string? primaryWindowTitle = null;
        for (var i = 0; i < candidates.Count; i++)
        {
            IReadOnlyList<IUiNode> windows;
            List<IUiNode> visible;
            try
            {
                windows = _scope.RunWindows(run, candidates[i].Window);
                // Elements another process hosts inside a run window (a re-parented window, a web view) do not count.
                visible = Match(windows, candidates[i].Path).Where(n => IsVisible(n) && _scope.IsRunProcess(run, n.ProcessId)).ToList();
            }
            catch (ElementGoneException)
            {
                // The UI changed under us; the next attempt sees the new tree.
                windows = [];
                visible = [];
            }
            if (i == 0)
            {
                primaryCount = visible.Count;
                primaryWindowTitle = windows.Count > 0 ? SafeName(windows[0]) : null;
            }
            if (visible.Count == 1)
            {
                var el = visible[0];
                var win = windows.FirstOrDefault(w => Contains(w, el)) ?? windows[0];
                return new Attempt(new Resolution(i, el, win), 0, null, target);
            }
        }
        return new Attempt(null, primaryCount, primaryWindowTitle, target);
    }

    /// <summary>Whether any candidate matches at least one visible element now.</summary>
    public bool AnyVisible(RunState run, Target target)
    {
        foreach (var t in new[] { target }.Concat(target.Fallbacks))
        {
            try
            {
                if (Match(_scope.RunWindows(run, t.Window), t.Path).Any(IsVisible)) return true;
            }
            catch (ElementGoneException)
            {
                // Treated as not visible, like a race in the browser.
            }
        }
        return false;
    }

    public sealed record Attempt(Resolution? Winner, int PrimaryCount, string? PrimaryWindowTitle, Target Target)
    {
        public RpcException Failure() => PrimaryCount > 1
            ? RpcErrors.NotUnique(PrimaryCount, Target.Describe())
            : RpcErrors.NotFound(Target.Describe(), PrimaryWindowTitle);
    }

    internal static List<IUiNode> Match(IReadOnlyList<IUiNode> roots, IReadOnlyList<Cond> path)
    {
        IReadOnlyList<IUiNode> current = roots;
        foreach (var cond in path)
        {
            var next = new List<IUiNode>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var node in current)
                foreach (var d in node.FindDescendants(cond))
                    if (seen.Add(d.Id)) next.Add(d);
            if (cond.Index is int index)
            {
                next = next
                    .GroupBy(n => n.GetParent()?.Id ?? "", StringComparer.Ordinal)
                    .Select(g => g.ElementAtOrDefault(index))
                    .Where(n => n is not null)
                    .Select(n => n!)
                    .ToList();
            }
            current = next;
            if (current.Count == 0) break;
        }
        return current.ToList();
    }

    public static bool Matches(IUiNode node, Cond cond) =>
        (cond.ControlType is null || string.Equals(node.ControlType, cond.ControlType, StringComparison.OrdinalIgnoreCase)) &&
        (cond.AutomationId is null || string.Equals(node.AutomationId, cond.AutomationId, StringComparison.Ordinal)) &&
        (cond.Name is null || string.Equals(node.Name, cond.Name, StringComparison.Ordinal)) &&
        (cond.ClassName is null || string.Equals(node.ClassName, cond.ClassName, StringComparison.Ordinal));

    /// <summary>The default descendant search: a depth-first walk over the children, in document order.</summary>
    public static IReadOnlyList<IUiNode> WalkFind(IUiNode root, Cond cond, int maxNodes = 20000)
    {
        var found = new List<IUiNode>();
        var stack = new Stack<IEnumerator<IUiNode>>();
        stack.Push(root.GetChildren().GetEnumerator());
        var visited = 0;
        while (stack.Count > 0 && visited < maxNodes)
        {
            var it = stack.Peek();
            if (!it.MoveNext())
            {
                stack.Pop();
                continue;
            }
            visited++;
            var n = it.Current;
            if (Matches(n, cond)) found.Add(n);
            stack.Push(n.GetChildren().GetEnumerator());
        }
        return found;
    }

    private static bool IsVisible(IUiNode n) => !n.IsOffscreen;

    private static bool Contains(IUiNode window, IUiNode el)
    {
        var cur = el.GetParent();
        for (var i = 0; i < 200 && cur is not null; i++)
        {
            if (cur.Id == window.Id) return true;
            cur = cur.GetParent();
        }
        return false;
    }

    private static string? SafeName(IUiNode n)
    {
        try { return n.Name; }
        catch (ElementGoneException) { return null; }
    }
}
