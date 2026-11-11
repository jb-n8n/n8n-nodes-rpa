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
        if (args.Count > 0) line.Append(' ').Append(JoinArguments(args));
        return line.ToString();
    }

    /// <summary>The arguments alone, quoted as <see cref="Join"/> quotes them.</summary>
    public static string JoinArguments(IReadOnlyList<string> args)
    {
        var line = new StringBuilder();
        for (var i = 0; i < args.Count; i++) Append(i == 0 ? line : line.Append(' '), args[i]);
        return line.ToString();
    }

    /// <summary>
    /// The arguments a person typed into the bar, split as a Windows program reads its command line: spaces and tabs
    /// separate them, quotes keep a path with spaces together (<c>""</c> is an empty argument, <c>\"</c> a quote), and
    /// backslashes count only before a quote. The inverse of <see cref="JoinArguments"/>.
    /// </summary>
    public static IReadOnlyList<string> Split(string line)
    {
        var args = new List<string>();
        var current = new StringBuilder();
        bool quoted = false, started = false;
        for (var i = 0; i < line.Length;)
        {
            var c = line[i];
            if (!quoted && c is ' ' or '\t')
            {
                if (started) { args.Add(current.ToString()); current.Clear(); started = false; }
                i++;
                continue;
            }
            started = true;
            if (c == '\\')
            {
                var backslashes = 0;
                while (i < line.Length && line[i] == '\\') { backslashes++; i++; }
                if (i < line.Length && line[i] == '"')
                {
                    current.Append('\\', backslashes / 2);
                    if (backslashes % 2 == 1) { current.Append('"'); i++; }
                }
                else current.Append('\\', backslashes);
                continue;
            }
            if (c == '"')
            {
                // Inside quotes, two quotes are one literal quote (as the C runtime reads them).
                if (quoted && i + 1 < line.Length && line[i + 1] == '"') { current.Append('"'); i += 2; continue; }
                quoted = !quoted;
                i++;
                continue;
            }
            current.Append(c);
            i++;
        }
        if (started) args.Add(current.ToString());
        return args;
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
