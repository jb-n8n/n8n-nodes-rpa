using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core;

/// <summary>
/// How a step finds its element again: control type plus a stable automation id plus the name, each when there is
/// one (the importer adds an id-only fallback when both are there); when that does not find exactly this one element,
/// the same under the element's nearest ancestor with a stable id. Never an index: an element is found by what it is,
/// not by its position among its siblings.
/// </summary>
public static partial class LocatorRules
{
    /// <summary>The element's own condition.</summary>
    public static RecordedCondition Condition(ElementFacts element) => new(
        Texts.Matchable(element.ControlType),
        StableIds.IsStable(element.AutomationId) ? Texts.Matchable(element.AutomationId) : null,
        Texts.Matchable(element.Name));

    /// <summary>
    /// The step's target. <paramref name="matches"/> is how many elements <see cref="Condition"/> found in the window;
    /// when it is not 1 the condition goes under the nearest ancestor (below the window) with a stable id, found by its
    /// control type and id. With no such ancestor, the element is recorded with what there is.
    /// </summary>
    public static RecordedTarget Target(WindowFacts window, ElementFacts element, int matches)
    {
        var own = Condition(element);
        var anchor = matches == 1 ? null : element.Ancestors.FirstOrDefault(a =>
            a.ControlType != "Window" && StableIds.IsStable(a.AutomationId) && Texts.Matchable(a.AutomationId) is not null);
        RecordedCondition[] path = anchor is null ? [own] : [new(Texts.Matchable(anchor.ControlType), anchor.AutomationId, null), own];
        return new(WindowRules.Window(window), path);
    }

    /// <summary>
    /// A read step's target. What a read takes is often the element's name itself (a label that says "6 line items"), so
    /// an element with a stable id is found by its control type and id alone. With no stable id the name stays (it is
    /// all there is), and <paramref name="byText"/> says so.
    /// </summary>
    public static RecordedTarget ReadTarget(WindowFacts window, ElementFacts element, out bool byText)
    {
        var target = Target(window, element, 1);
        var own = target.Path[^1];
        byText = own.AutomationId is null && own.Name is not null;
        return own.AutomationId is null ? target : target with { Path = [.. target.Path.SkipLast(1), own with { Name = null }] };
    }

    /// <summary>How a read step names its element: by its stable id, else by its control type, never by its text.</summary>
    public static string ReadLabel(ElementFacts element) => Texts.Label(
        StableIds.IsStable(element.AutomationId) && Texts.Matchable(element.AutomationId) is { } id ? id : element.ControlType);

    [GeneratedRegex(@"\bRow [0-9]+\b")] private static partial Regex RowPosition();

    /// <summary>Whether the target finds its element by a name that carries a row position ("Vendor Row 1"): on a later
    /// run it acts on whatever is in that row.</summary>
    public static bool IsPositional(RecordedTarget target) =>
        target.Path[^1] is { AutomationId: null, Name: { } name } && RowPosition().IsMatch(name);

    /// <summary>What the person saw on the element: its name, else its automation id, else its control type.</summary>
    public static string Label(ElementFacts element) => Texts.Label(
        !string.IsNullOrWhiteSpace(element.Name) ? element.Name : element.AutomationId.Length > 0 ? element.AutomationId : element.ControlType);
}
