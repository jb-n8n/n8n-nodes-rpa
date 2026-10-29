using System.Globalization;
using System.Text;

namespace ErpDemo;

/// <summary>One line item. All values are fixed by formula, so tests can assert exact rows.</summary>
internal sealed record LineItem(string Document, DateOnly Date, string Company, string Vendor, decimal Amount, string Currency, string Status)
{
    public string AmountText => Amount.ToString("0.00", CultureInfo.InvariantCulture);
    public string DateText => Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>The fake ledger: deterministic line items per company code.</summary>
internal static class LineItems
{
    public static readonly string[] Companies = ["1000", "2000", "3000"];

    private static readonly string[] Vendors =
        ["Acme Paper Co", "Blue River Logistics", "Granite Tools", "Harbor Foods", "Summit Energy"];

    private static readonly string[] Statuses = ["Open", "Cleared", "Blocked"];

    private static int CountFor(string company) => company switch { "1000" => 12, "2000" => 7, "3000" => 4, _ => 0 };

    private static string CurrencyFor(string company) => company switch { "1000" => "EUR", "2000" => "USD", _ => "GBP" };

    public static IReadOnlyList<LineItem> All(string company)
    {
        var code = int.Parse(company, CultureInfo.InvariantCulture);
        return Enumerable.Range(1, CountFor(company)).Select(i => new LineItem(
            Document: $"{company}-{i:0000}",
            Date: new DateOnly(2026, 1, 5).AddDays((i - 1) * 23),
            Company: company,
            Vendor: Vendors[(i + code / 1000) % Vendors.Length],
            Amount: 100m + (i * 7919 + code) % 100000 / 100m,
            Currency: CurrencyFor(company),
            Status: Statuses[i % Statuses.Length])).ToList();
    }

    public static IReadOnlyList<LineItem> Search(string company, DateOnly from, DateOnly to) =>
        All(company).Where(r => r.Date >= from && r.Date <= to).ToList();

    public const string CsvHeader = "Document,Date,Company,Vendor,Amount,Currency,Status";

    /// <summary>CSV with a header, invariant formats, CRLF line ends, UTF-8 without a byte order mark.</summary>
    public static byte[] ToCsv(IEnumerable<LineItem> rows)
    {
        var sb = new StringBuilder();
        sb.Append(CsvHeader).Append("\r\n");
        foreach (var r in rows)
            sb.Append(string.Join(',', new[] { r.Document, r.DateText, r.Company, r.Vendor, r.AmountText, r.Currency, r.Status }.Select(Quote))).Append("\r\n");
        return new UTF8Encoding(false).GetBytes(sb.ToString());
    }

    private static string Quote(string s) =>
        s.IndexOfAny([',', '"', '\r', '\n']) >= 0 ? "\"" + s.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" : s;
}
