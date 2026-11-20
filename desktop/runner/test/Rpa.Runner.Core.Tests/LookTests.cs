using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Rpa.Runner.Core.Protocol;
using Rpa.Runner.Core.Ui;

namespace Rpa.Runner.Core.Tests;

/// <summary>AI repair's look: the snapshot plus the masked, labelled picture of the run's windows (RepairPicture).</summary>
public sealed class LookTests : IDisposable
{
    private readonly Harness _h = new();

    public void Dispose() => _h.Dispose();

    private static readonly (byte, byte, byte) Grey = (200, 200, 200);

    /// <summary>The main window at (100, 50), 400 by 300, with controls laid out on it.</summary>
    private FakeNode App()
    {
        var w = _h.BeginWithApp();
        w.Bounds = new PixelRect(100, 50, 400, 300);
        Place(w, "txtUser", 110, 60, 100, 20);
        Place(w, "txtPassword", 110, 90, 100, 20);
        Place(w, "btnSignIn", 110, 120, 60, 24);
        Place(w, "btnPost", 200, 120, 60, 24);
        Place(w, "txtApiKey", 110, 150, 100, 20);
        Place(w, "btnInner", 300, 200, 60, 24);
        return w;
    }

    private static void Place(FakeNode w, string id, int x, int y, int width, int height) => w.Find(id).Bounds = new PixelRect(x, y, width, height);

    private JsonNode Look(object? extra = null)
    {
        var p = new JsonObject { ["runId"] = Harness.RunId, ["labelStart"] = 1 };
        if (extra is not null) foreach (var (k, v) in JsonSerializer.SerializeToNode(extra)!.AsObject()) p[k] = v?.DeepClone();
        return _h.Ok("look", p);
    }

    private static Picture Png(JsonNode r)
    {
        Assert.True(r["picture"] is not null, $"no picture: {r["noPicture"]}");
        var pic = Picture.Decode(Convert.FromBase64String(r["picture"]!["base64"]!.GetValue<string>()));
        Assert.Equal("image/png", r["picture"]!["mime"]!.GetValue<string>());
        Assert.Equal(pic.Width, r["picture"]!["width"]!.GetValue<int>());
        Assert.Equal(pic.Height, r["picture"]!["height"]!.GetValue<int>());
        return pic;
    }

    private static string Refusal(JsonNode r)
    {
        Assert.Null(r["picture"]);
        return r["noPicture"]!.GetValue<string>();
    }

    [Fact]
    public void Look_returns_the_snapshot_and_a_picture_of_the_run_window()
    {
        App();
        var r = Look();
        var snap = _h.Ok("snapshot", new { runId = Harness.RunId });
        Assert.Equal(snap["nodes"]!.ToJsonString(), r["nodes"]!.ToJsonString());
        Assert.Equal("ERP Demo - Line items", r["window"]!["title"]!.GetValue<string>());
        var pic = Png(r);
        Assert.Equal((400, 300), (pic.Width, pic.Height));
        // A spot of the window away from every control and label shows the window's own pixels.
        Assert.Equal(Grey, pic.At(380, 280));
    }

    [Fact]
    public void Password_and_credential_like_fields_are_covered_black()
    {
        App();
        var pic = Png(Look());
        // txtPassword (IsPassword) at (110, 90) and txtApiKey (credential-like name) at (110, 150), window at (100, 50).
        Assert.Equal((0, 0, 0), pic.At(10 + 50, 40 + 10));
        Assert.Equal((0, 0, 0), pic.At(10 + 50, 100 + 10));
        // The user name field (not masked, nothing typed) is not covered at its middle.
        Assert.Equal(Grey, pic.At(10 + 90, 10 + 15));
        Assert.Equal(2, Look()["picture"]!["masked"]!.GetValue<int>());
    }

    [Fact]
    public void A_field_the_run_typed_into_is_covered_even_when_its_value_is_not_given()
    {
        App();
        _h.Ok("act", new { runId = Harness.RunId, target = Harness.T(new { automationId = "txtUser" }), action = "type", value = "clerk", timeoutMs = 2000 });
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(10 + 90, 10 + 15));
        Assert.Equal(3, Look()["picture"]!["masked"]!.GetValue<int>());
    }

    [Fact]
    public void Controls_whose_name_or_value_holds_a_masked_text_are_covered_in_any_case()
    {
        var w = App();
        w.Child("Text", "Signed in as JDOE-4471 today", "lblWho", n => n.Bounds = new PixelRect(300, 60, 150, 20));
        w.Find("txtUser").Value = "jdoe-4471";
        var pic = Png(Look(new { mask = new[] { "JDOE-4471", "abc" } }));
        Assert.Equal((0, 0, 0), pic.At(200 + 70, 10 + 10));
        Assert.Equal((0, 0, 0), pic.At(10 + 90, 10 + 15));
        // A mask text shorter than 4 characters is not looked for (as the engine masks).
        Assert.Equal(4, Look(new { mask = new[] { "JDOE-4471", "abc" } })["picture"]!["masked"]!.GetValue<int>());
    }

    [Fact]
    public void The_cover_reaches_two_pixels_past_the_control()
    {
        App();
        var pic = Png(Look());
        // txtPassword spans x 10..110, y 40..60 in the picture; the cover from x 8 and y 38.
        Assert.Equal((0, 0, 0), pic.At(8, 38));
        Assert.Equal((0, 0, 0), pic.At(111, 61));
        Assert.Equal(Grey, pic.At(113, 63));
    }

    [Fact]
    public void Labels_carry_the_view_numbers_at_the_controls_top_left()
    {
        App();
        var r = Look(new { labelStart = 40 });
        var nodes = r["nodes"]!.AsArray();
        var signIn = nodes.Select((n, i) => (n, i)).Single(t => t.n!["automationId"]!.GetValue<string>() == "btnSignIn").i;
        var pic = Png(r);
        // btnSignIn at (110, 120) is (10, 70) in the picture: a label's black border, then yellow inside.
        Assert.Equal((0, 0, 0), pic.At(10, 70));
        Assert.Equal((255, 230, 0), pic.At(11, 71));
        Assert.True(r["picture"]!["labels"]!.GetValue<int>() >= 4);
        // The digits drawn are the number of the node: 40 + its index. Read back by drawing the same label.
        var expected = new Raster(60, 30);
        expected.DrawLabel((40 + signIn).ToString(System.Globalization.CultureInfo.InvariantCulture), 0, 0);
        var (lw, lh) = Raster.LabelSize((40 + signIn).ToString(System.Globalization.CultureInfo.InvariantCulture));
        for (var y = 0; y < lh; y++)
            for (var x = 0; x < lw; x++)
                Assert.Equal(expected.Pixel(x, y), pic.At(10 + x, 70 + y));
    }

    [Fact]
    public void A_window_of_another_application_is_never_in_the_picture()
    {
        App();
        // Another application's window in front of the run's, overlapping it.
        var other = new FakeNode("Window", "Mail", "", 4242) { Bounds = new PixelRect(150, 80, 300, 200) };
        _h.Processes.Names[4242] = "Mail.exe";
        _h.Desktop.Windows.Insert(0, other);
        _h.Desktop.WindowColor[other.Id] = (10, 200, 10);
        var pic = Png(Look());
        Assert.Equal((400, 300), (pic.Width, pic.Height));
        for (var y = 0; y < pic.Height; y += 7)
            for (var x = 0; x < pic.Width; x += 7)
                Assert.NotEqual((10, 200, 10), pic.At(x, y));
    }

    [Fact]
    public void The_runs_dialog_is_drawn_in_front_and_widens_the_picture()
    {
        var w = App();
        var dialog = new FakeNode("Window", "Confirm export", "dlgConfirm", w.ProcessId) { Bounds = new PixelRect(450, 100, 200, 100) };
        dialog.Child("Button", "Continue", "btnConfirmExport", n => n.Bounds = new PixelRect(460, 160, 80, 24));
        _h.Desktop.Windows.Insert(0, dialog);
        _h.Desktop.WindowColor[dialog.Id] = (30, 60, 220);
        var pic = Png(Look());
        Assert.Equal((550, 300), (pic.Width, pic.Height));
        Assert.Equal((30, 60, 220), pic.At(450 - 100 + 150, 100 - 50 + 80));
        // Where the dialog overlaps the main window, the dialog (in front) shows.
        Assert.Equal((30, 60, 220), pic.At(450 - 100 + 10, 100 - 50 + 10));
    }

    [Fact]
    public void Masked_controls_in_every_run_window_are_covered()
    {
        var w = App();
        var dialog = new FakeNode("Window", "Sign in again", "dlgAuth", w.ProcessId) { Bounds = new PixelRect(450, 100, 200, 100) };
        dialog.Child("Edit", "PIN", "txtPin", n => { n.IsPassword = true; n.Bounds = new PixelRect(470, 130, 100, 20); });
        _h.Desktop.Windows.Insert(0, dialog);
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(470 - 100 + 50, 130 - 50 + 10));
    }

    [Fact]
    public void Wide_windows_are_shrunk_to_1280_pixels_on_the_long_side()
    {
        var w = App();
        w.Bounds = new PixelRect(0, 0, 2560, 900);
        var pic = Png(Look());
        Assert.Equal(1280, pic.Width);
        Assert.Equal(450, pic.Height);
        var small = Png(Look(new { maxEdge = 640 }));
        Assert.Equal(640, small.Width);
    }

    [Fact]
    public void No_picture_when_a_control_that_must_be_covered_has_no_readable_position()
    {
        var w = App();
        w.Find("txtPassword").Bounds = null;
        var r = Look();
        Assert.Contains("cannot be read", Refusal(r));
        // The snapshot still comes back.
        Assert.NotEmpty(r["nodes"]!.AsArray());
    }

    [Fact]
    public void No_picture_when_a_control_that_must_be_covered_reports_no_size_while_on_the_screen()
    {
        var w = App();
        w.Find("txtPassword").Bounds = new PixelRect(0, 0, 0, 0);
        Assert.Contains("no size", Refusal(Look()));
        w.Find("txtPassword").IsOffscreen = true;
        Png(Look());
    }

    [Fact]
    public void No_picture_when_a_window_cannot_be_read_through_UI_Automation()
    {
        var w = App();
        w.Unreadable = true;
        Assert.Contains("cannot be read through UI Automation", Refusal(Look()));
    }

    [Fact]
    public void No_picture_when_a_run_window_holds_a_window_of_another_application()
    {
        var w = App();
        _h.Processes.Names[777] = "Other.exe";
        _h.Desktop.ChildProcesses[w.Id] = [w.ProcessId, 777];
        Assert.Contains("another application", Refusal(Look()));
        _h.Desktop.ChildProcesses[w.Id] = [w.ProcessId];
        Png(Look());
    }

    [Fact]
    public void No_picture_when_a_window_title_holds_a_masked_text()
    {
        var w = App();
        w.Name = "ERP Demo - jdoe-4471";
        Assert.Contains("window title", Refusal(Look(new { window = new { title = "ERP Demo - jdoe-4471" }, mask = new[] { "JDOE-4471" } })));
    }

    [Fact]
    public void No_picture_when_there_are_too_many_elements_to_check()
    {
        var w = App();
        var big = new FakeNode("List", "Big", "lstBig");
        for (var i = 0; i < RepairPicture.MaxCheckedElements; i++) big.Child("ListItem", $"Row {i}");
        w.Add(big);
        Assert.Contains("elements to check", Refusal(Look()));
    }

    [Fact]
    public void No_picture_when_the_window_shown_is_minimized()
    {
        var w = App();
        w.Bounds = null;
        Assert.Contains("could not be captured", Refusal(Look()));
    }

    [Fact]
    public void No_picture_when_the_ui_keeps_changing_under_the_check()
    {
        var w = App();
        w.Find("txtPassword").Gone = true;
        // Gone fails the control type read too, so the snapshot drops it; the check of what to cover keeps failing.
        Assert.Contains("kept changing", Refusal(Look()));
    }

    // Review fix 1: what changes between the check and the capture.

    [Fact]
    public void A_field_that_gets_a_masked_text_during_the_capture_is_covered()
    {
        var w = App();
        w.Child("Text", "", "lblLate", n => n.Bounds = new PixelRect(300, 60, 150, 20));
        _h.Desktop.AfterCapture = win => { if (win.Id == w.Id) w.Find("lblLate").Name = "Account JDOE-4471"; };
        var pic = Png(Look(new { mask = new[] { "JDOE-4471" } }));
        Assert.Equal((0, 0, 0), pic.At(200 + 70, 10 + 10));
    }

    [Fact]
    public void No_picture_when_a_window_moves_or_changes_size_during_the_capture()
    {
        var w = App();
        _h.Desktop.AfterCapture = win => { if (win.Id == w.Id) w.Bounds = new PixelRect(120, 50, 400, 300); };
        Assert.Contains("moved or changed size", Refusal(Look()));
        _h.Desktop.AfterCapture = win => { if (win.Id == w.Id) w.Bounds = new PixelRect(120, 50, 420, 300); };
        Assert.Contains("moved or changed size", Refusal(Look()));
    }

    [Fact]
    public void A_control_that_moved_during_the_capture_is_covered_where_it_was_and_where_it_is()
    {
        var w = App();
        _h.Desktop.AfterCapture = win => { if (win.Id == w.Id) w.Find("txtPassword").Bounds = new PixelRect(300, 260, 100, 20); };
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(10 + 50, 40 + 10));
        Assert.Equal((0, 0, 0), pic.At(200 + 50, 210 + 10));
    }

    [Fact]
    public void No_picture_when_Windows_scales_a_windows_drawing()
    {
        var w = App();
        _h.Desktop.DpiScaled.Add(w.Id);
        Assert.Contains("DPI", Refusal(Look()));
    }

    // Review fix 2: text beyond Name and Value, in the raw view.

    [Fact]
    public void A_document_whose_text_holds_a_masked_text_is_covered()
    {
        var w = App();
        w.Child("Document", "Notes", "docNotes", n => { n.Bounds = new PixelRect(300, 60, 150, 100); n.OtherTexts = ["line one", "card jdoe-4471 on file"]; });
        var pic = Png(Look(new { mask = new[] { "JDOE-4471" } }));
        Assert.Equal((0, 0, 0), pic.At(200 + 70, 10 + 50));
    }

    [Fact]
    public void An_element_whose_text_cannot_be_read_is_covered_whole_while_there_are_texts_to_look_for()
    {
        var w = App();
        w.Child("Custom", "", "", n => { n.Bounds = new PixelRect(300, 60, 150, 100); n.OtherTexts = null; });
        Assert.Equal(Grey, Png(Look()).At(200 + 70, 10 + 50));
        Assert.Equal((0, 0, 0), Png(Look(new { mask = new[] { "JDOE-4471" } })).At(200 + 70, 10 + 50));
    }

    [Fact]
    public void An_accessible_name_holding_a_masked_text_is_covered()
    {
        var w = App();
        w.Child("Pane", "", "", n => { n.Bounds = new PixelRect(300, 60, 150, 100); n.OtherTexts = ["JDOE-4471", ""]; });
        Assert.Equal((0, 0, 0), Png(Look(new { mask = new[] { "jdoe-4471" } })).At(200 + 70, 10 + 50));
    }

    // Review fix 3: what the run typed, not only where by runtime id.

    [Fact]
    public void Every_control_showing_a_text_the_run_typed_is_covered_without_the_engine_naming_it()
    {
        var w = App();
        w.Child("Text", "Welcome back, clerk", "lblWelcome", n => n.Bounds = new PixelRect(300, 60, 150, 20));
        _h.Ok("act", new { runId = Harness.RunId, target = Harness.T(new { automationId = "txtUser" }), action = "type", value = "clerk", timeoutMs = 2000 });
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(200 + 70, 10 + 10));
    }

    [Fact]
    public void A_typed_into_control_made_again_with_a_new_runtime_id_is_still_covered()
    {
        var w = App();
        _h.Ok("act", new { runId = Harness.RunId, target = Harness.T(new { automationId = "txtUser" }), action = "type", value = "abc", timeoutMs = 2000 });
        // The app creates the field again (a new runtime id) and it now shows something else.
        var old = w.Find("txtUser");
        old.AutomationId = "txtUserOld";
        old.Bounds = new PixelRect(0, 0, 0, 0);
        old.IsOffscreen = true;
        w.Child("Edit", "User name", "txtUser", n => { n.Value = "xyz"; n.Bounds = new PixelRect(300, 260, 100, 20); });
        Assert.NotEqual(old.Id, w.Find("txtUser").Id);
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(200 + 50, 210 + 10));
    }

    [Fact]
    public void A_text_typed_from_segments_is_looked_for_as_typed()
    {
        var w = App();
        _h.Ok("act", new { runId = Harness.RunId, target = Harness.T(new { automationId = "txtUser" }), action = "type",
            segments = new object[] { new { exportDir = true }, new { text = "\\line-items.csv" } }, timeoutMs = 2000 });
        w.Child("Text", $"Saved to {_h.ExportDir}\\line-items.csv", "lblSaved", n => n.Bounds = new PixelRect(300, 60, 150, 20));
        var pic = Png(Look());
        Assert.Equal((0, 0, 0), pic.At(200 + 70, 10 + 10));
    }

    [Fact]
    public void Mask_texts_are_checked()
    {
        App();
        _h.Err("look", new { runId = Harness.RunId, labelStart = 1, mask = "x" }, RpcErrors.InvalidParams);
        _h.Err("look", new { runId = Harness.RunId, labelStart = 1, mask = new object[] { 5 } }, RpcErrors.InvalidParams);
        _h.Err("look", new { runId = Harness.RunId, labelStart = 1, mask = Enumerable.Repeat("abcd", RunnerService.MaxMaskTexts + 1).ToArray() }, RpcErrors.InvalidParams);
        _h.Err("look", new { runId = Harness.RunId, labelStart = 1, mask = new[] { new string('a', RunnerService.MaxMaskTextLength + 1) } }, RpcErrors.InvalidParams);
        _h.Err("look", new { runId = Harness.RunId }, RpcErrors.InvalidParams);
    }

    [Fact]
    public void The_picture_and_the_mask_texts_are_never_logged()
    {
        using var h = new Harness(fileLog: true);
        var w = h.BeginWithApp();
        w.Bounds = new PixelRect(0, 0, 200, 100);
        w.Find("txtPassword").Bounds = new PixelRect(10, 10, 50, 20);
        w.Find("txtApiKey").Bounds = new PixelRect(10, 40, 50, 20);
        var r = h.Ok("look", new { runId = Harness.RunId, labelStart = 1, mask = new[] { "TOPSECRET-1" } });
        var log = h.LogText();
        Assert.True(log.Contains("look picture 200x100"), log);
        Assert.DoesNotContain("TOPSECRET-1", log);
        Assert.DoesNotContain(r["picture"]!["base64"]!.GetValue<string>()[..40], log);
    }

    [Fact]
    public void Png_round_trips_every_pixel()
    {
        var raster = new Raster(37, 11);
        var rnd = new Random(7);
        rnd.NextBytes(raster.Rgb);
        raster.DrawLabel("1234567890", 1, 0);
        var pic = Picture.Decode(raster.EncodePng());
        for (var y = 0; y < 11; y++)
            for (var x = 0; x < 37; x++)
                Assert.Equal(raster.Pixel(x, y), pic.At(x, y));
    }

    /// <summary>A minimal decoder for the runner's own PNGs (8-bit RGB, filters None, Sub and Up).</summary>
    private sealed record Picture(int Width, int Height, byte[] Rgb)
    {
        public (byte, byte, byte) At(int x, int y)
        {
            var i = (y * Width + x) * 3;
            return (Rgb[i], Rgb[i + 1], Rgb[i + 2]);
        }

        public static Picture Decode(byte[] png)
        {
            Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, png[..8]);
            int w = 0, h = 0;
            using var idat = new MemoryStream();
            for (var at = 8; at < png.Length;)
            {
                var len = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(at));
                var type = System.Text.Encoding.ASCII.GetString(png, at + 4, 4);
                var data = png.AsSpan(at + 8, len);
                if (type == "IHDR")
                {
                    w = BinaryPrimitives.ReadInt32BigEndian(data);
                    h = BinaryPrimitives.ReadInt32BigEndian(data[4..]);
                    Assert.Equal(8, data[8]);
                    Assert.Equal(2, data[9]);
                }
                if (type == "IDAT") idat.Write(data);
                at += 12 + len;
            }
            idat.Position = 0;
            using var z = new ZLibStream(idat, CompressionMode.Decompress);
            using var raw = new MemoryStream();
            z.CopyTo(raw);
            var bytes = raw.ToArray();
            var stride = w * 3;
            var rgb = new byte[stride * h];
            for (var y = 0; y < h; y++)
            {
                var f = bytes[y * (stride + 1)];
                for (var i = 0; i < stride; i++)
                {
                    var v = bytes[y * (stride + 1) + 1 + i];
                    var left = i >= 3 ? rgb[y * stride + i - 3] : 0;
                    var up = y > 0 ? rgb[(y - 1) * stride + i] : 0;
                    rgb[y * stride + i] = f switch { 0 => v, 1 => (byte)(v + left), 2 => (byte)(v + up), _ => throw new InvalidDataException($"filter {f}") };
                }
            }
            return new Picture(w, h, rgb);
        }
    }
}
