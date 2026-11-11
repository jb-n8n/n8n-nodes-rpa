using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core;

/// <summary>
/// Whether a UI Automation id is stable enough to go into a locator: the twin of the engine's
/// <c>stableDesktopId</c> (packages/engine/src/desktop/stable-ids.ts), held to it by the samples in
/// packages/engine/test/fixtures/desktop/stable-id-samples.json. Short numeric ids (up to 5 digits) are standard
/// Win32 dialog control ids and are stable; GUIDs, hex salts, long digit runs and dotted runtime-id shapes are
/// generated per run. The patterns spell out what JavaScript's <c>\s</c> and <c>\d</c> mean, so both sides read an id
/// the same way.
/// </summary>
public static partial class StableIds
{
    private const string Space = @"[\t\n\v\f\r    -     　﻿]";

    [GeneratedRegex(Space)] private static partial Regex HasSpace();
    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}")] private static partial Regex GuidShape();
    [GeneratedRegex("[0-9]{6,}")] private static partial Regex LongDigits();
    [GeneratedRegex(@"^[0-9]+(\.[0-9]+)+\z")] private static partial Regex Dotted();
    [GeneratedRegex("[0-9a-fA-F]{8,}")] private static partial Regex HexRun();
    // WinForms names a list view's rows by their position: an index, not an id.
    [GeneratedRegex(@"^ListViewItem-[0-9]+\z")] private static partial Regex ListViewRow();
    [GeneratedRegex("[0-9]")] private static partial Regex Digit();
    [GeneratedRegex("[a-fA-F]")] private static partial Regex HexLetter();

    public static bool IsStable(string id)
    {
        if (id.Length == 0 || HasSpace().IsMatch(id)) return false;
        if (GuidShape().IsMatch(id) || LongDigits().IsMatch(id) || Dotted().IsMatch(id) || ListViewRow().IsMatch(id)) return false;
        return !HexRun().Matches(id).Any(run => Digit().IsMatch(run.Value) && HexLetter().IsMatch(run.Value));
    }
}
