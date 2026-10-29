using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Rpa.Runner.Core.Server;

/// <summary>Protects the stored private key at rest (DPAPI on Windows; nothing extra elsewhere, where the file is
/// readable by its owner only).</summary>
public interface IKeyProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

public sealed class NoKeyProtection : IKeyProtector
{
    public byte[] Protect(byte[] data) => data;
    public byte[] Unprotect(byte[] data) => data;
}

/// <summary>
/// The runner's TLS certificate: generated on first start (self-signed, ECDSA P-256, 10 years) and stored in the data
/// directory, so the fingerprint stays the same across restarts. The n8n side pins the SHA-256 fingerprint.
/// </summary>
public static class CertificateStore
{
    public const string FileName = "runner-certificate.pfx.bin";

    public static X509Certificate2 LoadOrCreate(string dataDir, IKeyProtector protector, RunnerLog log)
    {
        Directory.CreateDirectory(dataDir);
        var path = Path.Combine(dataDir, FileName);
        if (File.Exists(path))
        {
            byte[] pfx;
            try { pfx = protector.Unprotect(File.ReadAllBytes(path)); }
            catch (CryptographicException)
            {
                throw new InvalidOperationException(
                    $"cannot read the runner certificate at {path} (created by another Windows user?). Run the runner as " +
                    "the user that created it, or delete the file to generate a new certificate (its fingerprint changes).");
            }
            return Import(pfx);
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var subject = new X500DistinguishedName($"CN=RPA Runner {Sanitize(Environment.MachineName)}");
        var req = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        var host = Sanitize(Environment.MachineName).ToLowerInvariant();
        if (host.Length > 0 && host != "localhost") san.AddDnsName(host);
        req.CertificateExtensions.Add(san.Build());
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        var now = DateTimeOffset.UtcNow;
        using var created = req.CreateSelfSigned(now.AddDays(-1), now.AddYears(10));
        var bytes = created.Export(X509ContentType.Pfx);
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, protector.Protect(bytes));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(tmp, path, overwrite: false);
        log.Info("generated a new self-signed certificate");
        return Import(bytes);
    }

    /// <summary>The SHA-256 fingerprint of the DER certificate: uppercase hex, colon-separated.</summary>
    public static string Fingerprint(X509Certificate2 cert) =>
        string.Join(':', SHA256.HashData(cert.RawData).Select(b => b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture)));

    // A key imported from a PFX (not an ephemeral one) works with SChannel on Windows as well as OpenSSL elsewhere.
    private static X509Certificate2 Import(byte[] pfx) =>
        new(pfx, (string?)null, OperatingSystem.IsWindows() ? X509KeyStorageFlags.UserKeySet : X509KeyStorageFlags.DefaultKeySet);

    private static string Sanitize(string s) => new(s.Where(c => char.IsAsciiLetterOrDigit(c) || c == '-').ToArray());
}
