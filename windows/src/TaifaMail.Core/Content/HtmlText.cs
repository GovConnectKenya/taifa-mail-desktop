using System.Net;
using System.Text.RegularExpressions;

namespace TaifaMail.Core.Content;

public static class HtmlText
{
    /// <summary>Plain text of an HTML fragment, for the editor and fallbacks. Not a sanitizer: output is shown as text only.</summary>
    public static string Strip(string html)
    {
        var t = Regex.Replace(html ?? "", "<(br|/p|/div|/li)\\s*/?>", "\n", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, "<[^>]+>", "");
        return WebUtility.HtmlDecode(t).Replace("\r\n", "\n").Trim();
    }
}
