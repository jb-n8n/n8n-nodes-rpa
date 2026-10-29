using System.Text.RegularExpressions;
using Rpa.Runner.Core.Protocol;

namespace Rpa.Runner.Core.Files;

/// <summary>
/// file.retrieve: returns a file from the run's export directory (top level only, regular files only, never a link)
/// whose name matches the pattern, once its size has stopped changing and it can be opened without sharing writes.
/// When several match, the most recently written wins. Error messages never name the file: its name may have been typed.
/// </summary>
public sealed class ExportFiles
{
    private readonly TimeProvider _time;

    public ExportFiles(TimeProvider time) => _time = time;

    public static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

    public sealed record Retrieved(string Name, long Size, byte[] Bytes);

    public Retrieved Retrieve(string exportDir, string pattern, TimeSpan timeout, long maxBytes, CancellationToken ct = default)
    {
        Regex regex;
        try { regex = new Regex(pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)); }
        catch (ArgumentException) { throw RpcErrors.InvalidParamsError("pattern is not a valid regular expression"); }

        var deadline = _time.GetUtcNow() + timeout;
        var root = Path.GetFullPath(exportDir);
        (string Path, long Size)? lastSeen = null;
        while (true)
        {
            var candidate = Newest(root, regex);
            if (candidate is not null)
            {
                var size = candidate.Length;
                if (size > maxBytes)
                    throw RpcErrors.PolicyRefused($"the matching file is {size} bytes, over the limit of {maxBytes} bytes");
                // Stable: same file, same size as on the previous poll, and openable while denying writers.
                if (lastSeen is { } prev && prev.Path == candidate.FullName && prev.Size == size)
                {
                    var bytes = TryRead(candidate, maxBytes);
                    if (bytes is not null) return new Retrieved(candidate.Name, bytes.LongLength, bytes);
                }
                lastSeen = (candidate.FullName, size);
            }
            if (_time.GetUtcNow() >= deadline)
            {
                throw RpcErrors.ExpectedFileMissing(candidate is null
                    ? "no file matching the pattern appeared in the export directory within the timeout"
                    : "the matching file was still being written when the timeout passed");
            }
            ct.ThrowIfCancellationRequested();
            Thread.Sleep(PollInterval);
        }
    }

    private static FileInfo? Newest(string root, Regex regex)
    {
        if (!Directory.Exists(root)) return null;
        FileInfo? best = null;
        foreach (var f in new DirectoryInfo(root).EnumerateFiles("*", new EnumerationOptions
                 {
                     RecurseSubdirectories = false,
                     AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.Hidden | FileAttributes.System,
                     IgnoreInaccessible = true,
                 }))
        {
            bool match;
            try { match = regex.IsMatch(f.Name); }
            catch (RegexMatchTimeoutException) { match = false; }
            if (!match) continue;
            // Belt and braces: the resolved path must sit directly in the export directory.
            if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(f.FullName)), root, StringComparison.OrdinalIgnoreCase)) continue;
            if (best is null || f.LastWriteTimeUtc > best.LastWriteTimeUtc ||
                (f.LastWriteTimeUtc == best.LastWriteTimeUtc && string.CompareOrdinal(f.Name, best.Name) < 0))
                best = f;
        }
        return best;
    }

    private static byte[]? TryRead(FileInfo f, long maxBytes)
    {
        try
        {
            using var s = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (s.Length > maxBytes) throw RpcErrors.PolicyRefused($"the matching file is over the limit of {maxBytes} bytes");
            var buf = new byte[s.Length];
            s.ReadExactly(buf);
            return buf;
        }
        catch (IOException)
        {
            return null; // still open for writing by the app
        }
    }
}
