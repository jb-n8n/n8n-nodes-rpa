using System.ComponentModel;
using System.Runtime.InteropServices;
using Rpa.Supervisor.Core;

namespace Rpa.Supervisor;

/// <summary>Reads a secret the installer stored in the local security authority (LSA private data). Secrets whose
/// name starts with L$ can be read on this machine only; reading needs administrator rights, and the service runs as
/// SYSTEM.</summary>
internal static class LsaSecret
{
    /// <summary>The bot user's password.</summary>
    public const string BotPasswordName = "L$RpaRunnerBotPassword";

    private const uint PolicyGetPrivateInformation = 0x00000004;
    private const uint StatusObjectNameNotFound = 0xC0000034;

    /// <summary>The secret's text. Throws SessionException(NoPassword) when it is missing, empty or cannot be read.</summary>
    public static string Read(string name)
    {
        var attributes = new LSA_OBJECT_ATTRIBUTES { Length = Marshal.SizeOf<LSA_OBJECT_ATTRIBUTES>() };
        var status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyGetPrivateInformation, out var policy);
        if (status != 0) throw Unreadable(name, status);
        var key = new LSA_UNICODE_STRING
        {
            Length = (ushort)(name.Length * 2),
            MaximumLength = (ushort)(name.Length * 2),
            Buffer = Marshal.StringToHGlobalUni(name),
        };
        try
        {
            status = LsaRetrievePrivateData(policy, ref key, out var data);
            if (status == StatusObjectNameNotFound)
                throw new SessionException(SessionFailure.NoPassword, $"No password is stored for the bot user (the LSA secret {name} is missing).");
            if (status != 0) throw Unreadable(name, status);
            try
            {
                var value = data == IntPtr.Zero ? default : Marshal.PtrToStructure<LSA_UNICODE_STRING>(data);
                if (value.Length == 0 || value.Buffer == IntPtr.Zero)
                    throw new SessionException(SessionFailure.NoPassword, $"The stored password of the bot user is empty (the LSA secret {name}).");
                // A secret written with its terminating NUL holds it in its length.
                var text = Marshal.PtrToStringUni(value.Buffer, value.Length / 2).TrimEnd('\0');
                Marshal.Copy(new byte[value.Length], 0, value.Buffer, value.Length); // no copy left in freed memory
                if (text.Length == 0)
                    throw new SessionException(SessionFailure.NoPassword, $"The stored password of the bot user is empty (the LSA secret {name}).");
                return text;
            }
            finally
            {
                if (data != IntPtr.Zero) LsaFreeMemory(data);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(key.Buffer);
            LsaClose(policy);
        }
    }

    private static SessionException Unreadable(string name, uint status) =>
        new(SessionFailure.NoPassword,
            $"The stored password of the bot user (the LSA secret {name}) could not be read: {new Win32Exception((int)LsaNtStatusToWinError(status)).Message}");

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attributes, uint access, out IntPtr policy);

    [DllImport("advapi32.dll")]
    private static extern uint LsaRetrievePrivateData(IntPtr policy, ref LSA_UNICODE_STRING keyName, out IntPtr privateData);

    [DllImport("advapi32.dll")]
    private static extern uint LsaFreeMemory(IntPtr buffer);

    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policy);

    [DllImport("advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(uint status);
}
