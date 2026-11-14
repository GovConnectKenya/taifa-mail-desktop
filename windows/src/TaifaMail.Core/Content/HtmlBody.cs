using System.Net;
using System.Text;

namespace TaifaMail.Core.Content;

public sealed record BodyColors(string Text, string Link, string Background = "transparent");

/// <summary>
/// Wraps a received message's HTML for the locked down viewer: a Content Security Policy that blocks
/// scripts, frames, forms and (until allowed) every remote load, plus theme CSS and a 14px base font.
/// The viewer also denies http and https requests at the network layer, so a CSP gap is not the only guard.
/// </summary>
public static class HtmlBody
{
    public static string Wrap(string html, bool allowRemoteImages, bool dark, BodyColors colors)
    {
        var img = allowRemoteImages ? "img-src data: cid: https: http:" : "img-src data: cid:";
        var csp = $"default-src 'none'; {img}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html><head><meta charset=\"utf-8\">");
        sb.Append("<meta http-equiv=\"Content-Security-Policy\" content=\"").Append(WebUtility.HtmlEncode(csp)).Append("\">");
        sb.Append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
        sb.Append("<meta name=\"color-scheme\" content=\"").Append(dark ? "dark" : "light").Append("\">");
        sb.Append("<style>");
        sb.Append(":root{color-scheme:").Append(dark ? "dark" : "light").Append("}");
        sb.Append("html,body{margin:0;padding:0;background:").Append(colors.Background).Append(";color:").Append(colors.Text).Append("}");
        sb.Append("body{font:14px/22px 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;overflow-wrap:anywhere;word-break:break-word;-webkit-user-select:text;user-select:text}");
        sb.Append("a{color:").Append(colors.Link).Append("}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid rgba(128,128,128,.4)}");
        sb.Append("</style></head><body>").Append(html).Append("</body></html>");
        return sb.ToString();
    }

    /// <summary>Plain text bodies render natively; this finds links for the native text control to make clickable.</summary>
    public static IReadOnlyList<(int Start, int Length)> FindLinks(string text)
    {
        var found = new List<(int, int)>();
        foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(text, @"https?://[^\s<>""']+", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var len = m.Length;
            while (len > 0 && ".,;:!?)]}".Contains(m.Value[len - 1])) len--;
            if (len > 8) found.Add((m.Index, len));
        }
        return found;
    }

    /// <summary>
    /// Map from each anchor's href to the text a reader sees for it, so the link prompt can flag a visible host
    /// that differs from the real one. The viewer runs no script, so the page itself cannot report this.
    /// </summary>
    public static Dictionary<string, string> LinkTexts(string html)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(html ?? "",
            "<a\\s[^>]*?href\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')[^>]*>(.*?)</a>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline))
        {
            var href = WebUtility.HtmlDecode(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value).Trim();
            var text = WebUtility.HtmlDecode(System.Text.RegularExpressions.Regex.Replace(m.Groups[3].Value, "<[^>]+>", "")).Trim();
            if (href.Length > 0 && text.Length > 0) map.TryAdd(href, text);
        }
        return map;
    }
}
