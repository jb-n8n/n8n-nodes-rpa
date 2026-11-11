using System.Text;

namespace Rpa.Recorder.Core;

/// <summary>
/// The command line the recorder starts the chosen program with: the program in quotes, then each argument quoted the
/// way Windows programs read their command line back (the rules of CommandLineToArgvW and the C runtime): an argument
/// with a space, a tab, a line break or a quote, or an empty one, goes in quotes; inside, a quote gets a backslash, and
/// backslashes are doubled only where they come before a quote.
/// </summary>
public static class CommandLine
{
    public static string Join(string program, IReadOnlyList<string> args)
    {
        if (program.Contains('"')) throw new ArgumentException("a program's path cannot hold a quote", nameof(program));
        var line = new StringBuilder().Append('"').Append(program).Append('"');
        foreach (var arg in args) Append(line.Append(' '), arg);
        return line.ToString();
    }

    private static void Append(StringBuilder line, string arg)
    {
        if (arg.Length > 0 && !arg.Any(c => char.IsWhiteSpace(c) || c == '"'))
        {
            line.Append(arg);
            return;
        }
        line.Append('"');
        for (var i = 0; i < arg.Length; i++)
        {
            var backslashes = 0;
            while (i < arg.Length && arg[i] == '\\') { backslashes++; i++; }
            if (i == arg.Length) { line.Append('\\', backslashes * 2); break; }
            if (arg[i] == '"') line.Append('\\', backslashes * 2 + 1).Append('"');
            else line.Append('\\', backslashes).Append(arg[i]);
        }
        line.Append('"');
    }
}
