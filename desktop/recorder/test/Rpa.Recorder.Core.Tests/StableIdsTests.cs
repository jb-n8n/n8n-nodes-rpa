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
        // JavaScript's \s includes U+FEFF and not U+0085, and its \d is 0-9 only.
        Assert.False(StableIds.IsStable("a﻿b"));
        Assert.False(StableIds.IsStable("a b"));
        Assert.True(StableIds.IsStable("a\u0085b"));
        Assert.True(StableIds.IsStable("١٢٣٤٥٦"));
    }
}
