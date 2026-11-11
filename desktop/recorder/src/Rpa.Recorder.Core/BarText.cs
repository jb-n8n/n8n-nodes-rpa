namespace Rpa.Recorder.Core;

/// <summary>
/// The bar's stages, in order. Ready: nothing chosen yet. Starting: the chosen program is starting. Recording and
/// Paused: the person works in the app. Finished: the recording ended and is not saved (or changed since it was).
/// Saved: finished and saved, with what to do next.
/// </summary>
public enum BarStage { Ready, Starting, Recording, Paused, Finished, Saved }

/// <summary>The colour of the dot before the state line: red while recording, amber while paused, grey otherwise.</summary>
public enum BarColor { Neutral, Recording, Paused }

/// <summary>The parts of the bar below the state line, the guidance and the notice line.</summary>
[Flags]
public enum BarPart
{
    None = 0,
    /// <summary>Start an app… and Use an app that is already open….</summary>
    StartButtons = 1,
    /// <summary>The two sentences about what gets recorded.</summary>
    ReadyText = 2,
    /// <summary>Pause (or Resume) and Finish.</summary>
    RecordButtons = 4,
    List = 8,
    /// <summary>The line about F9 under the list.</summary>
    ReadHint = 16,
    /// <summary>Delete step, Make it a variable…, Make it a secret… with the line that says what they act on.</summary>
    StepActions = 32,
    /// <summary>Name, the folder with Change folder…, and Save.</summary>
    SaveBlock = 64,
    /// <summary>The two numbered lines of what to do next, and Record another.</summary>
    NextSteps = 128,
}

/// <summary>What the bar says at each stage, and the names of its actions (an action has the same name everywhere).</summary>
public static class BarText
{
    public const string Title = "RPA Recorder";
    public const string StartApp = "Start an app…";
    public const string UseOpenApp = "Use an app that is already open…";
    public const string Finish = "Finish";
    public const string DeleteStep = "Delete step";
    // Short enough that the three step actions fit one row on a bar 360 wide.
    public const string MakeVariable = "Make variable…";
    public const string MakeSecret = "Make secret…";
    public const string Name = "Name";
    public const string Save = "Save";
    public const string ChangeFolder = "Change folder…";
    public const string RecordAnother = "Record another";
    public const string ReadHint = "Point at a value in the app and press F9 to read it on every run.";
    /// <summary>The empty list before anything is recorded.</summary>
    public const string EmptyList = "The steps appear here once the app is recording.";

    /// <summary>The two sentences of Ready. On a small screen (<paramref name="narrow"/>, see
    /// <see cref="BarLayout.WidthFor"/>) the second also says that the bar can be moved.</summary>
    public static IReadOnlyList<string> ReadySentences(bool narrow) =>
    [
        "Your clicks and what you type in that app become steps, listed here as plain sentences.",
        "Clicks on this window are never recorded, and password boxes are never read." + (narrow ? " Drag this window if it covers the app." : ""),
    ];

    /// <summary>The program's file name, as the state line names the app.</summary>
    public static string AppName(string? programPath) => string.IsNullOrEmpty(programPath) ? "the app" : WindowRules.FileName(programPath);

    public static string Steps(int count) => count == 1 ? "1 step" : $"{count} steps";

    /// <summary>The top line: the state in words, with the step count.</summary>
    public static string StateLine(BarStage stage, string? programPath, int steps) => stage switch
    {
        BarStage.Ready => "Ready",
        BarStage.Starting => $"Starting {AppName(programPath)}…",
        BarStage.Recording => $"Recording {AppName(programPath)} · {(steps == 0 ? "no steps yet" : Steps(steps))}",
        BarStage.Paused => $"Paused · {Steps(steps)}",
        _ => $"Finished · {Steps(steps)}",
    };

    public static BarColor Color(BarStage stage) => stage switch
    {
        BarStage.Recording => BarColor.Recording,
        BarStage.Paused => BarColor.Paused,
        _ => BarColor.Neutral,
    };

    /// <summary>The sentence under the state line: what to do now. Saved names the file and its folder.</summary>
    public static string Guidance(BarStage stage, string? savedFile = null, string? savedFolder = null) => stage switch
    {
        BarStage.Ready => "Choose the app to record.",
        BarStage.Starting => "Wait for its window: recording starts when it shows.",
        BarStage.Recording => "Do the work in the app. Each step appears in the list below.",
        BarStage.Paused => "Nothing is recorded until you resume.",
        BarStage.Finished => "Check the steps, then name the recording and save it.",
        _ => $"Saved {savedFile} in {savedFolder}. Two things are left to do:",
    };

    /// <summary>What the stage shows. Once saved, the step actions show only while a step is selected: they belong to
    /// editing, and the list needs the room.</summary>
    public static BarPart Parts(BarStage stage, bool stepSelected = false) => stage switch
    {
        BarStage.Ready => BarPart.StartButtons | BarPart.ReadyText | BarPart.List,
        BarStage.Starting => BarPart.List,
        BarStage.Recording or BarStage.Paused => BarPart.RecordButtons | BarPart.List | BarPart.ReadHint | BarPart.StepActions,
        BarStage.Finished => BarPart.List | BarPart.StepActions | BarPart.SaveBlock,
        _ => BarPart.List | BarPart.NextSteps | (stepSelected ? BarPart.StepActions : BarPart.None),
    };

    /// <summary>How many one-line rows the list keeps at least: the bar grows downward for them
    /// (<see cref="BarLayout.GrowForList"/>) where the list shows steps.</summary>
    public static int MinListRows(BarStage stage) => stage is BarStage.Ready or BarStage.Starting ? 0 : 6;

    public static string PauseButton(BarStage stage) => stage == BarStage.Paused ? "Resume" : "Pause";

    /// <summary>
    /// The text of the stage's one primary button (the window's default button), or null. While recording there is
    /// none: Enter in the bar must not finish the recording. After saving it is Allow this app… while that can be
    /// done here, else Show the file; none while the policy tool waits for its answer (its button is there but
    /// disabled), so that an Enter meant for the tool's window does nothing in the bar.
    /// </summary>
    public static string? Primary(BarStage stage, NextLine? allow = null) => stage switch
    {
        BarStage.Ready => StartApp,
        BarStage.Finished => Save,
        BarStage.Saved => allow switch
        {
            { Button: { } button, ButtonEnabled: true } => button,
            { Button: not null, ButtonEnabled: false } => null,
            _ => NextSteps.ShowFile,
        },
        _ => null,
    };
}
