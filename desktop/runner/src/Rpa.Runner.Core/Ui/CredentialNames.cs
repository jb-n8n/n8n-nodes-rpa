using System.Text.RegularExpressions;

namespace Rpa.Runner.Core.Ui;

// The credential-like names, in one file that two projects compile: the runner (Redaction, public there through
// Snapshot.cs) and the recorder (Rpa.Recorder.Core links this file; internal there). No access modifier here on
// purpose, so each project keeps its own.
static partial class Redaction
{
    [GeneratedRegex(
        @"password|passwort|passwd|passcode|passphrase|\bpass\b|pwd|kennwort|contrase|mot\s*de\s*passe|secret|token|credential|api[\s_-]?key|\bpin\b|\botp\b|one[\s-]?time|\b2fa\b|\bmfa\b|\bcvv\b|\bcvc\b|security\s*code",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CredentialLike();

    public static bool IsCredentialLike(string? text) => !string.IsNullOrEmpty(text) && CredentialLike().IsMatch(text);
}
