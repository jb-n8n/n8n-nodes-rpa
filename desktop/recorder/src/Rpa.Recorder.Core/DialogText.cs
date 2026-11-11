namespace Rpa.Recorder.Core;

/// <summary>A question that asks for a name: its title, what it acts on, the name box's label and suggestion, and
/// its action button (the button that opens it has the same words, with an ellipsis).</summary>
public sealed record NameQuestion(string Title, string Text, string NameLabel, string Suggested, string Action);

/// <summary>A question before something is lost or replaced: its title, its text and its action button.</summary>
public sealed record Question(string Title, string Text, string Action);

/// <summary>The texts of the bar's small windows. Each says what it acts on; its action comes first, then Cancel.</summary>
public static class DialogText
{
    public const string Cancel = "Cancel";
    public const string Close = "Close";
    public const string NameRule = "Letters, digits and _, starting with a letter or _, at most 64 characters.";
    private const string NameShape = "A name holds only letters, digits and _, starts with a letter or _, and has at most 64 characters.";
    private const int MaxSeen = 60;

    public const string StartTitle = "Start an app";
    public const string StartProgram = "App";
    public const string Browse = "Browse…";
    public const string PickTitle = "Choose the app to record";
    public const string StartArguments = "Arguments (optional)";
    public const string ArgumentsNote = Notices.Arguments;
    public const string QuotesNote = "Separate them with spaces; put one that holds spaces in quotes.";
    public const string StartAction = "Start recording";

    public const string OpenTitle = "Use an app that is already open";
    public const string OpenText = "Choose the window of the app to record.";
    public const string OpenNone = "No other app has a window open. Open the app first, or choose Start an app… on the bar.";

    public const string FolderTitle = "Choose the folder for the recording";
    public const string NoticesTitle = "Earlier notices";

    public static string WindowEntry(string title, string exe) => $"{title} ({exe})";

    public static NameQuestion Secret(int number, RecordedStep step) => new(
        $"Make step {number} a secret",
        $"Step {number} {StepText.Describe(step)}. The typed value is removed from the recording now. " +
        "On each run it comes from the secret variable below, which n8n supplies from an RPA Secret Variables credential.",
        "Secret variable name",
        StepText.SuggestedName(step),
        Action(BarText.MakeSecret));

    /// <summary>The F9 question: the element as the person sees it (its text now, else its id, else its kind).</summary>
    public static NameQuestion Read(int number, ElementFacts element) => new(
        "Read a value",
        $"Step {number} reads {Seen(element)}. On each run the bot reads it again and returns what it shows under the name below.",
        "Output name",
        StepText.SuggestedReadName(element),
        "Add read step");

    /// <summary>What is wrong with a typed name, or null when it can be used. <paramref name="taken"/> are names that
    /// another step already returns.</summary>
    public static string? NameProblem(string name, IEnumerable<string> taken)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0) return "Type a name.";
        if (!SecretRules.IsVariableName(trimmed)) return NameShape;
        if (taken.Contains(trimmed, StringComparer.Ordinal)) return $"Another read step already returns {trimmed}: choose another name.";
        return null;
    }

    /// <summary>What is wrong with the program and arguments of Start an app, or null when the recorder can try them.
    /// The same limits as a recording's (Session).</summary>
    public static string? StartProblem(string program, string arguments, Func<string, bool> exists)
    {
        var path = program.Trim();
        if (path.Length == 0) return "Choose the app's program file (.exe).";
        if (!WindowRules.IsExeName(WindowRules.FileName(path))) return "The app must be a program file (.exe).";
        if (!exists(path)) return $"There is no program at {path}.";
        var args = CommandLine.Split(arguments);
        if (args.Any(a => a.Contains("{{"))) return "The arguments may not hold {{.";
        if (args.Count > Session.MaxArgs || args.Any(a => a.Length > Session.MaxArgLength))
            return $"A recording takes at most {Session.MaxArgs} arguments of at most {Session.MaxArgLength} characters each.";
        return null;
    }

    public static Question CloseUnsaved(int steps) => new("Close the recorder", $"{Unsaved(steps)} Close the recorder and lose {Them(steps)}?", "Close without saving");

    public static Question StartOverUnsaved(int steps) => new(BarText.RecordAnother, $"{Unsaved(steps)} Start a new recording and lose {Them(steps)}?", "Start over");

    public static Question Replace(string folderShown, IReadOnlyList<string> files) => new(
        "Replace the saved files",
        $"{folderShown} already has {string.Join(" and ", files)}. Replace {(files.Count == 1 ? "it" : "them")}?",
        "Replace");

    private static string Unsaved(int steps) => steps == 1 ? "The recorded step is not saved." : $"The {steps} recorded steps are not saved.";

    private static string Them(int steps) => steps == 1 ? "it" : "them";

    private static string Action(string button) => button.TrimEnd('…');

    private static string Seen(ElementFacts element)
    {
        var kind = element.ControlType switch
        {
            "Text" => "text",
            "Edit" or "Document" => "box",
            "ComboBox" => "list",
            "DataItem" or "Cell" => "cell",
            "ListItem" or "TreeItem" => "item",
            "Button" => "button",
            "CheckBox" => "check box",
            "RadioButton" => "option",
            "Hyperlink" => "link",
            "Header" or "HeaderItem" => "heading",
            _ => "element",
        };
        var text = string.Join(' ', element.Name.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (text.Length > 0) return $"the {kind} \"{(text.Length > MaxSeen ? text[..(MaxSeen - 1)] + "…" : text)}\"";
        if (StableIds.IsStable(element.AutomationId) && element.AutomationId.Length > 0) return $"the {kind} with the id {Notices.Short(element.AutomationId)}";
        return $"the {kind} under the pointer";
    }
}
