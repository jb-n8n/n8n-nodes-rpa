using System.Text.RegularExpressions;
using Rpa.Runner.Core.Ui;

namespace Rpa.Recorder.Core;

/// <summary>
/// Which fields are secret. A secret field's value is never read and never kept: its fill is one run variable,
/// <c>{{var.name}}</c>, marked secret. A field is secret when UI Automation flags it as a password, or when its name or
/// automation id is credential-like by the runner's names (<c>Redaction</c>) or names a password field by the
/// importer's (<c>CREDENTIAL_FIELD</c> in packages/engine/src/secrets/credential-field.ts, which refuses a typed value in
/// such a field). A password box the recorder does not recognise is marked secret by the person on the bar.
/// </summary>
public static partial class SecretRules
{
    /// <summary>The importer's PASSWORD_WORDS, word for word (a test reads them from credential-field.ts).</summary>
    internal static readonly string[] PasswordWords =
    [
        "password", "passwd", "passcode", "pwd", "(?<!com|by)pass(?!enger|port)",
        "passwort", "kennwort",
        "contrase(?:ñ|n)a",
        "mot[ _-]?de[ _-]?passe",
        "parola d['’]ordine",
        "senha",
        "wachtwoord",
        "l(?:ö|o)senord",
        "adgangskode", "kodeord",
        "passord",
        "has(?:ł|l)o",
        "heslo",
        "(?:ş|s)ifre",
        "пароль",
        "パスワード",
        "密码", "密碼",
        "비밀번호",
    ];

    /// <summary>The importer's CREDENTIAL_FIELD: the password words, PIN and secret. JavaScript's <c>\b</c> is spelled out
    /// as a boundary of ASCII word characters.</summary>
    internal static readonly string CredentialFieldPattern = string.Join('|', PasswordWords) + "|(?<![A-Za-z0-9_])pin(?![A-Za-z0-9_])|secret";
    private static readonly Regex CredentialField = new(CredentialFieldPattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool IsSecret(ElementFacts field) =>
        field.IsPassword || CredentialLike(field.Name) || CredentialLike(field.AutomationId);

    /// <summary>The password flag as UI Automation gave it. A flag that could not be read counts as set: a field that
    /// may be a password box is never read.</summary>
    public static bool PasswordFlag(bool? read) => read ?? true;

    /// <summary>Whether a field is secret, with its password flag read again on the live element just before its value
    /// would be read (<paramref name="flagNow"/>, null when that read failed).</summary>
    public static bool IsSecret(ElementFacts field, bool? flagNow) => PasswordFlag(flagNow) || IsSecret(field);

    private static bool CredentialLike(string text) => Redaction.IsCredentialLike(text) || CredentialField.IsMatch(text);

    [GeneratedRegex("[^a-z0-9]+")] private static partial Regex NotNameChars();
    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")] private static partial Regex VariableNameShape();

    /// <summary>A run variable's or a read's name as the steps accept it: a letter or _ first, then letters, digits and _,
    /// at most 64 characters (READ_NAME in the engine).</summary>
    public static bool IsVariableName(string name) => VariableNameShape().IsMatch(name);

    /// <summary>The run variable a field's value goes into: its name (or automation id) in lower case, with <c>_</c> between
    /// words, at most 60 characters ("Password" gives <c>password</c>).</summary>
    public static string VariableName(ElementFacts field)
    {
        static string Words(string text) => NotNameChars().Replace(text.Trim().ToLowerInvariant(), "_").Trim('_');
        var name = Words(field.Name);
        if (name.Length == 0) name = Words(field.AutomationId);
        if (name.Length == 0 || char.IsAsciiDigit(name[0])) name = "field_" + name;
        return name.Length > 60 ? name[..60].TrimEnd('_') : name.TrimEnd('_');
    }
}
