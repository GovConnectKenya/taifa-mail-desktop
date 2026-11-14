using System.Text;
using System.Text.RegularExpressions;

namespace TaifaMail.Core.Security;

/// <summary>
/// Rewrites a sender's remote images to the server's image proxy (webmail image-proxy.svelte.ts), so the reader's
/// address never reaches the sender. Direct remote loads stay blocked in the viewer.
/// </summary>
public static class ImageProxy
{
    public static string Base64Url(string value) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static string ProxyUrl(string apiBase, string mailboxId, string capability, string target) =>
        $"{apiBase.TrimEnd('/')}/v1/inbox/{Uri.EscapeDataString(mailboxId)}/images/{Uri.EscapeDataString(capability)}?u={Base64Url(target)}";

    private static readonly Regex Img = new("(<img\\b[^>]*?\\bsrc\\s*=\\s*)([\"'])(https?://[^\"']+)\\2", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Only http and https targets of img src are rewritten. Other remote loads (css, background) stay unproxied and blocked.</summary>
    public static string Rewrite(string html, string apiBase, string mailboxId, string capability) =>
        Img.Replace(html, m => m.Groups[1].Value + m.Groups[2].Value + System.Net.WebUtility.HtmlEncode(ProxyUrl(apiBase, mailboxId, capability, System.Net.WebUtility.HtmlDecode(m.Groups[3].Value))) + m.Groups[2].Value);

    public static bool IsProxyRequest(Uri uri, string apiBase, string mailboxId) =>
        Uri.TryCreate(apiBase, UriKind.Absolute, out var b) && uri.Host == b.Host && uri.AbsolutePath.StartsWith($"/v1/inbox/{mailboxId}/images/", StringComparison.OrdinalIgnoreCase);
}
