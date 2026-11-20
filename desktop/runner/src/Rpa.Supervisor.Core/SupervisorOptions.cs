namespace Rpa.Supervisor.Core;

/// <summary>The proxy listens on ListenPort and passes each connection to 127.0.0.1:TargetPort, where the runner or
/// the browser host listens inside the bot user's session.</summary>
public sealed record PortMap(int ListenPort, int TargetPort);

/// <param name="User">The bot user the supervisor signs in.</param>
/// <param name="Ports">The ports the proxy listens on and where it passes each connection.</param>
/// <param name="ListenAddresses">The addresses the proxy listens on, for every port map.</param>
/// <param name="IdleSeconds">The session is signed out when no connection has held it for this long; 0 signs it out
/// as soon as the last connection closes.</param>
/// <param name="ReadySeconds">How long a connection waits for the session and its target together.</param>
/// <param name="StateFile">The JSON file that names the session the supervisor created and its last failure; empty
/// keeps them in memory only.</param>
public sealed record SupervisorOptions(string User, IReadOnlyList<PortMap> Ports, IReadOnlyList<string> ListenAddresses,
    int IdleSeconds = 15, int ReadySeconds = 90, string StateFile = "");
