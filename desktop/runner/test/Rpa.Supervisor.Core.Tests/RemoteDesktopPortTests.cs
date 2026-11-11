namespace Rpa.Supervisor.Core.Tests;

public sealed class RemoteDesktopPortTests
{
    [Fact]
    public void A_running_service_that_alone_listens_on_the_port_is_ready()
    {
        Assert.Null(RemoteDesktopPort.Problem(true, 1200, [1200, 1200]));
    }

    [Fact]
    public void No_listener_at_all_is_not_a_problem_of_this_check()
    {
        Assert.Null(RemoteDesktopPort.Problem(true, 1200, []));
    }

    [Theory]
    [InlineData(false, 1200u)]
    [InlineData(true, 0u)]
    public void A_service_that_is_not_running_or_has_no_process_is_not_running(bool running, uint processId)
    {
        Assert.Equal("The Remote Desktop service (TermService) is not running", RemoteDesktopPort.Problem(running, processId, [1200]));
    }

    [Fact]
    public void Any_other_listener_on_the_port_is_named_by_its_process()
    {
        // A user's listener on 127.0.0.2:3389 made while the service was stopped stays beside it after it starts.
        Assert.Equal("Another program (process 4242, 5000) listens on the Remote Desktop port 3389",
            RemoteDesktopPort.Problem(true, 1200, [1200, 5000, 4242, 1200, 4242]));
    }
}
