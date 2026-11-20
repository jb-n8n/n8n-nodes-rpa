using System.Reflection;
using System.Text.RegularExpressions;

namespace Rpa.Recorder.Core.Tests;

/// <summary>The log of the bar's own actions: stage changes and buttons pressed, with the time, and nothing else.</summary>
public sealed class BarLogTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "bar-log-" + Guid.NewGuid().ToString("N"));
    private static readonly DateTimeOffset T = new(2026, 11, 11, 14, 47, 13, 250, TimeSpan.FromHours(1));

    public void Dispose()
    {
        if (Directory.Exists(_folder)) Directory.Delete(_folder, recursive: true);
    }

    [Fact]
    public void It_writes_a_line_per_stage_change_and_per_button_with_the_time()
    {
        var path = BarLog.PathIn(_folder)!;
        Assert.Equal(Path.Combine(_folder, "RPA Recorder", "bar.log"), path);
        var log = new BarLog(path, () => T);
        log.Stage(BarStage.Ready);
        // The bar shows the same stage again often (a new step, a selection): one line per change only.
        log.Stage(BarStage.Ready);
        log.Pressed(BarButton.StartApp, BarStage.Ready);
        log.Stage(BarStage.Recording);
        log.Pressed(BarButton.RecordAnother, BarStage.Saved);
        Assert.Equal(
        [
            "2026-11-11 14:47:13.250 +01:00 stage Ready",
            "2026-11-11 14:47:13.250 +01:00 button StartApp in Ready",
            "2026-11-11 14:47:13.250 +01:00 stage Recording",
            "2026-11-11 14:47:13.250 +01:00 button RecordAnother in Saved",
        ], File.ReadAllLines(path));
    }

    [Fact]
    public void It_takes_only_a_stage_and_a_button_so_no_step_text_or_typed_value_can_reach_it()
    {
        // Every public method takes enums only: a string (a step's sentence, a typed value, a window title, a path)
        // does not compile. The path and the clock are given once, when the bar makes the log.
        var methods = typeof(BarLog).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert.Equal(["Pressed", "Stage"], methods.Select(m => m.Name).Order());
        Assert.All(methods.SelectMany(m => m.GetParameters()), p => Assert.True(p.ParameterType.IsEnum, p.Name));
        Assert.All(typeof(BarLog).GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly), m => Assert.Equal(nameof(BarLog.PathIn), m.Name));

        var path = BarLog.PathIn(_folder)!;
        var log = new BarLog(path, () => T);
        foreach (var stage in Enum.GetValues<BarStage>())
        {
            log.Stage(stage);
            foreach (var button in Enum.GetValues<BarButton>()) log.Pressed(button, stage);
        }
        Assert.All(File.ReadAllLines(path), line => Assert.Matches(new Regex(@"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d (stage [A-Za-z]+|button [A-Za-z]+ in [A-Za-z]+)$"), line));
    }

    [Fact]
    public void A_file_of_200_KB_is_started_again()
    {
        var path = BarLog.PathIn(_folder)!;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, new string('x', (int)BarLog.MaxBytes - 10));
        new BarLog(path, () => T).Stage(BarStage.Ready);
        Assert.Equal(["2026-11-11 14:47:13.250 +01:00 stage Ready"], File.ReadAllLines(path));
        Assert.True(new FileInfo(path).Length < BarLog.MaxBytes);
    }

    [Fact]
    public void A_failure_to_write_is_ignored()
    {
        // The log's folder is a file: nothing can be written there.
        Directory.CreateDirectory(_folder);
        File.WriteAllText(Path.Combine(_folder, "RPA Recorder"), "");
        var log = new BarLog(BarLog.PathIn(_folder), () => T);
        log.Stage(BarStage.Ready);
        log.Pressed(BarButton.Save, BarStage.Finished);
        // No folder for local application data: no log at all.
        Assert.Null(BarLog.PathIn(""));
        new BarLog(null, () => T).Stage(BarStage.Ready);
    }
}
