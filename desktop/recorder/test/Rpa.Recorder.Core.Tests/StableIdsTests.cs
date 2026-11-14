using System.Text.Json;
using static Rpa.Recorder.Core.Tests.Fakes;

namespace Rpa.Recorder.Core.Tests;

public class StableIdsTests
{
    private sealed record Sample(string Id, bool Stable);

    [Fact]
    public void StableIds_agrees_with_every_sample()
    {
        // The engine's stableDesktopId is held to the same file (packages/engine/src/desktop/stable-ids.ts).
        var samples = JsonSerializer.Deserialize<List<Sample>>(RepoFile("packages", "engine", "test", "fixtures", "desktop", "stable-id-samples.json"),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Assert.True(samples.Count >= 20);
        Assert.All(samples, s => Assert.True(StableIds.IsStable(s.Id) == s.Stable, $"{JsonSerializer.Serialize(s.Id)} should be {(s.Stable ? "stable" : "generated")}"));
    }

    [Fact]
    public void StableIds_reads_spaces_and_digits_as_the_engine_does()
    {
        // JavaScript's \s, every code point of it (it includes U+FEFF and not U+0085), and its \d is 0-9 only.
        int[] jsSpace = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
            0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF];
        for (var c = 0; c <= 0xFFFF; c++)
        {
            if (c is >= 0xD800 and <= 0xDFFF) continue;
            Assert.True(StableIds.IsStable($"a{(char)c}b") != jsSpace.Contains(c), $"U+{c:X4}");
        }
        Assert.True(StableIds.IsStable("\u0661\u0662\u0663\u0664\u0665\u0666"));
    }
}
