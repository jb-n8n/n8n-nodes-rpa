using System.Text.Json.Nodes;

namespace Rpa.Supervisor.Core.Tests;

public sealed class InstallFileTests
{
    private const string StateFile = @"C:\ProgramData\RPA Runner\supervisor-state.json";

    private static JsonObject Unattended() => new()
    {
        ["version"] = "0.2.0",
        ["mode"] = "unattended",
        ["user"] = "rpabot",
        ["runnerPort"] = 8765,
        ["browserPort"] = 3000,
        ["runnerInnerPort"] = 18765,
        ["browserInnerPort"] = 13000,
        ["idleSeconds"] = 60,
        ["listenAddresses"] = new JsonArray("10.0.0.5", "127.0.0.1"),
    };

    private static SupervisorOptions? Read(JsonObject install) => InstallFile.ToOptions(install.ToJsonString(), StateFile);

    private static string Refused(JsonObject install) => Assert.Throws<InvalidDataException>(() => Read(install)).Message;

    [Fact]
    public void An_unattended_install_becomes_the_supervisor_s_options()
    {
        var options = Read(Unattended())!;

        Assert.Equal("rpabot", options.User);
        Assert.Equal([new PortMap(8765, 18765), new PortMap(3000, 13000)], options.Ports);
        Assert.Equal(["10.0.0.5", "127.0.0.1"], options.ListenAddresses);
        Assert.Equal(60, options.IdleSeconds);
        Assert.Equal(StateFile, options.StateFile);
    }

    [Fact]
    public void Without_browserPort_only_the_runner_is_proxied()
    {
        var install = Unattended();
        install.Remove("browserPort");
        install.Remove("browserInnerPort");

        Assert.Equal([new PortMap(8765, 18765)], Read(install)!.Ports);
    }

    [Fact]
    public void Without_idleSeconds_and_listenAddresses_the_defaults_apply()
    {
        var install = Unattended();
        install.Remove("idleSeconds");
        install.Remove("listenAddresses");

        var options = Read(install)!;
        Assert.Equal(15, options.IdleSeconds);
        Assert.Equal(["0.0.0.0"], options.ListenAddresses);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("autoSignIn")]
    [InlineData("Unattended")]
    public void Any_other_mode_gives_no_options(string? mode)
    {
        var install = Unattended();
        install["mode"] = mode;
        if (mode is null) install.Remove("mode");

        Assert.Null(Read(install));
    }

    [Fact]
    public void Today_s_install_file_without_a_mode_gives_no_options()
    {
        var install = new JsonObject { ["version"] = "0.2.0", ["user"] = "rpabot", ["runnerPort"] = 8765, ["browserPort"] = 3000 };

        Assert.Null(Read(install));
    }

    [Fact]
    public void A_file_that_is_not_JSON_is_refused()
    {
        var message = Assert.Throws<InvalidDataException>(() => InstallFile.ToOptions("{ \"mode\": ", StateFile)).Message;
        Assert.StartsWith("install.json is not valid JSON", message);
    }

    [Fact]
    public void A_missing_user_is_refused()
    {
        var install = Unattended();
        install.Remove("user");

        Assert.Equal("install.json: user must be the name of a local Windows user (at most 20 characters, without a domain).",
            Refused(install));
    }

    [Theory]
    [InlineData(@"CORP\rpabot")]
    [InlineData("rpabot@corp.example")]
    [InlineData("")]
    [InlineData("rpa\nbot")]
    [InlineData("a-name-longer-than-twenty")]
    public void A_user_that_is_not_a_plain_local_name_is_refused(string user)
    {
        var install = Unattended();
        install["user"] = user;

        Assert.StartsWith("install.json: user must be the name of a local Windows user", Refused(install));
    }

    [Theory]
    [InlineData("runnerPort")]
    [InlineData("runnerInnerPort")]
    public void A_missing_runner_port_is_refused(string field)
    {
        var install = Unattended();
        install.Remove(field);

        Assert.Equal($"install.json: {field} must be a port number from 1 to 65535.", Refused(install));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public void A_port_out_of_range_is_refused(int port)
    {
        var install = Unattended();
        install["browserInnerPort"] = port;

        Assert.Equal("install.json: browserInnerPort must be a port number from 1 to 65535.", Refused(install));
    }

    [Fact]
    public void A_port_written_as_text_is_refused()
    {
        var install = Unattended();
        install["runnerPort"] = "8765";

        Assert.Equal("install.json: runnerPort must be a port number from 1 to 65535.", Refused(install));
    }

    [Fact]
    public void A_browserPort_without_browserInnerPort_is_refused()
    {
        var install = Unattended();
        install.Remove("browserInnerPort");

        Assert.Equal("install.json: browserInnerPort must be a port number from 1 to 65535.", Refused(install));
    }

    [Theory]
    [InlineData("runnerInnerPort", 8765)]
    [InlineData("browserPort", 8765)]
    [InlineData("browserInnerPort", 18765)]
    public void Ports_that_are_not_all_different_are_refused(string field, int port)
    {
        // A proxy that listened on its own target port would pass each connection to itself.
        var install = Unattended();
        install[field] = port;

        Assert.Equal("install.json: the ports the RPA Supervisor listens on and the ports it passes connections to must all be different.",
            Refused(install));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(86401)]
    public void An_idleSeconds_out_of_range_is_refused(int seconds)
    {
        var install = Unattended();
        install["idleSeconds"] = seconds;

        Assert.Equal("install.json: idleSeconds must be a whole number from 0 to 86400.", Refused(install));
    }

    [Fact]
    public void A_listen_address_that_is_not_an_IP_address_is_refused()
    {
        var install = Unattended();
        install["listenAddresses"] = new JsonArray("0.0.0.0", "bot.example");

        Assert.Equal("install.json: listenAddresses must be a list of IP addresses.", Refused(install));
    }

    [Fact]
    public void An_empty_list_of_listen_addresses_is_refused()
    {
        var install = Unattended();
        install["listenAddresses"] = new JsonArray();

        Assert.Equal("install.json: listenAddresses must be a list of IP addresses.", Refused(install));
    }
}
