using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>
/// The Remote Desktop host, RpaSupervisor.exe rdp-host, which the service starts for each connection. It reads the bot
/// user's name and password from standard input (one line each), connects to this machine at 127.0.0.2 through the
/// RDP client control that ships with Windows (mstscax.dll), and writes RdpHostEvent lines on standard output. Its
/// window is in the service's session (Session 0), where nobody sees it. Every second a watchdog answers any message
/// box of the process with its default button (or closes it when it finds none) and reports the box's text: in
/// Session 0 nobody could answer it, and it blocks the control's events. A fourth box before the session is Active
/// gives the attempt up. The host disconnects and exits when its standard input closes, and exits when the
/// connection ends.
/// </summary>
internal sealed class RdpHostWindow : Form
{
    private const string Server = "127.0.0.2";
    // "." is this machine: the bot user is a local user. With an empty domain, Network Level Authentication fails
    // inside the client in the service's session (disconnect reason 519) and the control shows a message box.
    private const string LocalDomain = ".";
    // The RDP client control (MsRdpClient9NotSafeForScripting), registered by mstscax.dll.
    private const string ControlClsid = "{8B918B82-7985-4C24-89DF-C33AD2BBFBCD}";
    private const int DesktopWidth = 1280;
    private const int DesktopHeight = 800;
    private const int TickMs = 250;
    private const int DialogTicks = 4; // 1 s
    private const int MaxPresses = 3;
    private const int AliveTicks = 20; // 5 s, well within the service's 30 s
    private const int EndTicks = 40; // 10 s for the disconnect event once the end was asked or the connection dropped

    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    private readonly StreamWriter _output;
    private readonly string _user;
    private string? _password;
    private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;
    private readonly RdpControl _control = new(ControlClsid) { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = TickMs };
    private readonly RdpClientEvents _events = new();
    private readonly HashSet<IntPtr> _dialogs = [];
    private readonly WindowsSessions _sessions = new();
    private dynamic? _rdp;
    private ConnectionPointCookie? _cookie;
    private volatile bool _inputClosed;
    private bool _connected; // from now on the session may become Active
    private bool _activeSent;
    private bool _ended;
    private int _ticks;
    private int _endTicks = -1;
    private int _exitCode;
    private int _presses;

    private RdpHostWindow(StreamWriter output, string user, string password)
    {
        _output = output;
        _user = user;
        _password = password;
        Text = "RPA Supervisor Remote Desktop host";
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = Point.Empty;
        ClientSize = new Size(DesktopWidth, DesktopHeight);
        ((ISupportInitialize)_control).BeginInit();
        Controls.Add(_control);
        ((ISupportInitialize)_control).EndInit();
        _events.Connected = () => _connected = true;
        _events.Disconnected = OnDisconnected;
        _events.FatalError = code => Fail($"The Remote Desktop client reported fatal error {code}.");
        _events.LogonError = code => Emit(_output, new RdpHostEvent.LogonError(code));
        _events.Warning = code => Emit(_output, new RdpHostEvent.Warning(code));
        _timer.Tick += (_, _) => OnTick();
    }

    public static int Run()
    {
        // An exception ends the host: a Windows Forms error box would wait for a click nobody can give.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        var output = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true };
        var input = new StreamReader(Console.OpenStandardInput(), Utf8);
        var user = input.ReadLine();
        var password = input.ReadLine();
        if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(password))
        {
            Emit(output, new RdpHostEvent.Failed("The user name and the password were not given on standard input."));
            return 2;
        }

        using var window = new RdpHostWindow(output, user, password);
        password = null;
        new Thread(() =>
        {
            try
            {
                while (input.ReadLine() is not null)
                {
                }
            }
            catch (IOException)
            {
            }
            window._inputClosed = true;
        }) { IsBackground = true, Name = "standard input" }.Start();
        Application.Run(window);
        return window._exitCode;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _timer.Start();
        Connect();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _timer.Stop();
        try
        {
            _cookie?.Dispose();
        }
        catch (COMException)
        {
            // The control is going away with the window.
        }
        base.OnFormClosed(e);
    }

    private void Connect()
    {
        try
        {
            dynamic rdp = _control.Ocx ?? throw new InvalidOperationException("The RDP client control could not be created.");
            _rdp = rdp;
            _cookie = new ConnectionPointCookie(rdp, _events);
            rdp.Server = Server;
            rdp.UserName = _user;
            rdp.Domain = LocalDomain;
            rdp.DesktopWidth = DesktopWidth;
            rdp.DesktopHeight = DesktopHeight;
            rdp.ColorDepth = 32;
            dynamic advanced = rdp.AdvancedSettings9;
            advanced.EnableCredSspSupport = true; // Network Level Authentication
            // No check of the server's identity: the server is this machine, reached over the loopback.
            advanced.AuthenticationLevel = 0u;
            advanced.EnableAutoReconnect = false;
            advanced.MinutesToIdleTimeout = 0;
            advanced.RedirectClipboard = false;
            advanced.RedirectPrinters = false;
            advanced.RedirectDrives = false;
            advanced.BitmapPeristence = 0; // the control's own spelling
            ((IMsTscNonScriptable)rdp).PutClearTextPassword(_password);
            _password = null;
            rdp.Connect();
        }
        catch (Exception e)
        {
            Fail($"The Remote Desktop connection could not be started: {e.Message}");
        }
    }

    private void OnTick()
    {
        _ticks++;
        if (_ended)
        {
            Close();
            return;
        }
        if (_ticks % DialogTicks == 0) AnswerDialogs();
        if (_ticks % AliveTicks == 0) Emit(_output, new RdpHostEvent.Alive());

        var state = ConnectedState();
        if (state == 1) _connected = true;
        if (_connected && !_activeSent && ActiveSessionId() is { } id)
        {
            _activeSent = true;
            Emit(_output, new RdpHostEvent.Active(id));
        }

        if (_inputClosed && _endTicks < 0)
        {
            _endTicks = 0;
            if (state == 0) _ended = true;
            else Disconnect();
        }
        // A connection that dropped without its event yet: the event normally follows at once.
        if (_activeSent && state == 0 && _endTicks < 0) _endTicks = 0;
        if (_endTicks >= 0 && ++_endTicks > EndTicks)
        {
            Emit(_output, new RdpHostEvent.Disconnected(0, 0, "The connection ended without a disconnect event."));
            _ended = true;
        }
    }

    // The control's Connected property: 0 not connected, 1 connected, 2 connecting; -1 when it cannot be read.
    private int ConnectedState()
    {
        try
        {
            return _rdp is null ? -1 : (int)(short)_rdp.Connected;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    // The bot user's Active session that began after this host started, once there is one.
    private uint? ActiveSessionId()
    {
        try
        {
            return _sessions.ForUser(_user)
                .Where(s => s.State == SessionState.Active && s.LogonTime >= _started)
                .OrderByDescending(s => s.LogonTime)
                .Select(s => (uint?)s.Id)
                .FirstOrDefault();
        }
        catch (Win32Exception)
        {
            return null;
        }
    }

    private void Disconnect()
    {
        try
        {
            _rdp?.Disconnect();
        }
        catch (Exception)
        {
            _ended = true;
        }
    }

    // Runs inside the control's event; the window closes on the next tick, outside it.
    private void OnDisconnected(int reason)
    {
        if (_ended) return;
        _ended = true;
        var extended = 0;
        var description = "";
        try
        {
            extended = (int)_rdp!.ExtendedDisconnectReason;
            description = (string)_rdp.GetErrorDescription((uint)reason, (uint)extended);
        }
        catch (Exception)
        {
            // The numbers say what happened; the description is only text.
        }
        Emit(_output, new RdpHostEvent.Disconnected(reason, extended, description));
    }

    // The window closes on the next tick.
    private void Fail(string text)
    {
        if (_ended) return;
        _ended = true;
        _exitCode = 1;
        Emit(_output, new RdpHostEvent.Failed(text));
    }

    private void AnswerDialogs()
    {
        foreach (var dialog in DialogWindows.Of(Environment.ProcessId))
        {
            // Before the session is Active a box that keeps coming back would hold the attempt until its time limit.
            if (!_activeSent)
            {
                if (_presses == MaxPresses)
                {
                    Fail($"The Remote Desktop client showed a message again after {MaxPresses} were answered; the attempt is given up.");
                    return;
                }
                _presses++;
            }
            var text = DialogWindows.Text(dialog);
            var pressed = DialogWindows.PressDefaultButton(dialog);
            if (_dialogs.Add(dialog)) Emit(_output, new RdpHostEvent.Dialog(pressed, text));
        }
    }

    private static void Emit(StreamWriter output, RdpHostEvent e)
    {
        try
        {
            output.WriteLine(e.ToLine());
        }
        catch (IOException)
        {
            // The service has gone; its job object ends this process.
        }
    }

    private sealed class RdpControl(string clsid) : AxHost(clsid)
    {
        public object? Ocx => GetOcx();
    }

    /// <summary>The control's event connection point (what AxHost.ConnectionPointCookie does).</summary>
    private sealed class ConnectionPointCookie : IDisposable
    {
        private readonly IConnectionPoint _point;
        private readonly int _cookie;

        public ConnectionPointCookie(object source, object sink)
        {
            var iid = typeof(IMsTscAxEvents).GUID;
            ((IConnectionPointContainer)source).FindConnectionPoint(ref iid, out _point);
            _point.Advise(sink, out _cookie);
        }

        public void Dispose() => _point.Unadvise(_cookie);

        [ComImport, Guid("B196B284-BAB4-101A-B69C-00AA00341D07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IConnectionPointContainer
        {
            void EnumConnectionPoints(out IntPtr points);
            void FindConnectionPoint(ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IConnectionPoint point);
        }

        [ComImport, Guid("B196B286-BAB4-101A-B69C-00AA00341D07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IConnectionPoint
        {
            void GetConnectionInterface(out Guid iid);
            void GetConnectionPointContainer(out IntPtr container);
            void Advise([MarshalAs(UnmanagedType.Interface)] object sink, out int cookie);
            void Unadvise(int cookie);
            void EnumConnections(out IntPtr connections);
        }
    }

    /// <summary>Message boxes (dialog class #32770) of a process.</summary>
    private static class DialogWindows
    {
        private const string DialogClass = "#32770";
        private const int DM_GETDEFID = 0x0400;
        private const int DC_HASDEFID = 0x534B;
        private const int BM_CLICK = 0x00F5;
        private const int WM_CLOSE = 0x0010;

        public static List<IntPtr> Of(int processId)
        {
            var dialogs = new List<IntPtr>();
            EnumWindows((window, _) =>
            {
                GetWindowThreadProcessId(window, out var owner);
                if (owner == processId && ClassOf(window) == DialogClass) dialogs.Add(window);
                return true;
            }, IntPtr.Zero);
            return dialogs;
        }

        /// <summary>The title of a box and the texts of its child windows other than its buttons and edit fields (Edit,
        /// RichEdit and the like: what is typed into a field, a password among others, is not put in the log).</summary>
        public static string Text(IntPtr dialog)
        {
            var parts = new List<string> { TextOf(dialog) };
            EnumChildWindows(dialog, (child, _) =>
            {
                var name = ClassOf(child);
                if (name != "Button" && !name.Contains("Edit", StringComparison.OrdinalIgnoreCase)) parts.Add(TextOf(child));
                return true;
            }, IntPtr.Zero);
            return string.Join(": ", parts.Where(p => p.Length > 0));
        }

        /// <summary>Presses the box's default button (true), or closes it when no such button is found (false).</summary>
        public static bool PressDefaultButton(IntPtr dialog)
        {
            var result = (long)SendMessage(dialog, DM_GETDEFID, IntPtr.Zero, IntPtr.Zero);
            if (((result >> 16) & 0xFFFF) == DC_HASDEFID && GetDlgItem(dialog, (int)(result & 0xFFFF)) is var button && button != IntPtr.Zero)
            {
                SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return true;
            }
            PostMessage(dialog, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            return false;
        }

        private static string ClassOf(IntPtr window)
        {
            var name = new StringBuilder(256);
            return GetClassName(window, name, name.Capacity) > 0 ? name.ToString() : "";
        }

        private static string TextOf(IntPtr window)
        {
            var text = new StringBuilder(1024);
            return GetWindowText(window, text, text.Capacity) > 0 ? text.ToString().Trim() : "";
        }

        private delegate bool EnumProc(IntPtr window, IntPtr parameter);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDlgItem(IntPtr dialog, int id);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }
}

/// <summary>Sets the control's password. Its only method is the first of an IUnknown interface, so the password is
/// never a scriptable property.</summary>
[ComImport, Guid("C1E6743A-41C1-4A74-832A-0DD06C1C7A0E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMsTscNonScriptable
{
    void PutClearTextPassword([MarshalAs(UnmanagedType.BStr)] string? value);
}

/// <summary>The control's events the host uses (IMsTscAxEvents, a dispatch interface).</summary>
[ComImport, Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IMsTscAxEvents
{
    [DispId(1)] void OnConnecting();
    [DispId(2)] void OnConnected();
    [DispId(3)] void OnLoginComplete();
    [DispId(4)] void OnDisconnected(int discReason);
    [DispId(10)] void OnFatalError(int errorCode);
    [DispId(11)] void OnWarning(int warningCode);
    [DispId(22)] void OnLogonError(int lError);
}

/// <summary>The sink the control calls through IDispatch.</summary>
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class RdpClientEvents : IMsTscAxEvents
{
    internal Action? Connected;
    internal Action<int>? Disconnected;
    internal Action<int>? FatalError;
    internal Action<int>? LogonError;
    internal Action<int>? Warning;

    public void OnConnecting() { }
    public void OnConnected() => Connected?.Invoke();
    public void OnLoginComplete() => Connected?.Invoke();
    public void OnDisconnected(int discReason) => Disconnected?.Invoke(discReason);
    public void OnFatalError(int errorCode) => FatalError?.Invoke(errorCode);
    public void OnWarning(int warningCode) => Warning?.Invoke(warningCode);

    // -2 says that the logon goes on; it comes with every sign-in.
    public void OnLogonError(int lError)
    {
        if (lError != -2) LogonError?.Invoke(lError);
    }
}
