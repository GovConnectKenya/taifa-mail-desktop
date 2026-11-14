using System.Globalization;

namespace TaifaMail.Core.Content;

public sealed record LinkCheck(bool Allowed, string Scheme, string Host, string DisplayHost, bool HostDiffersFromText, Uri? Uri)
{
    /// <summary>True when the host is not plain ASCII or mixes scripts: the prompt then shows both forms.</summary>
    public bool ShowBothForms => Host.Length > 0 && !string.Equals(Host, DisplayHost, StringComparison.OrdinalIgnoreCase) || LinkSafety.MixesScripts(DisplayHost);
}

/// <summary>
/// Host check shown before any link leaves the app (spec section 13). Only http, https and mailto are
/// opened. The real host is shown punycode decoded, and flagged when the visible link text names another host.
/// </summary>
public static class LinkSafety
{
    public static LinkCheck Check(string url, string? visibleText = null)
    {
        if (!Uri.TryCreate(url?.Trim(), UriKind.Absolute, out var uri))
            return new LinkCheck(false, "", "", "", false, null);

        var scheme = uri.Scheme.ToLowerInvariant();
        if (scheme == "mailto")
        {
            var domain = uri.Host;
            return new LinkCheck(true, scheme, domain, DecodeHost(domain), false, uri);
        }
        if (scheme is not ("http" or "https") || string.IsNullOrEmpty(uri.Host))
            return new LinkCheck(false, scheme, "", "", false, null);

        var host = uri.IdnHost.ToLowerInvariant();
        var shown = DecodeHost(host);
        return new LinkCheck(true, scheme, host, shown, TextNamesOtherHost(visibleText, host), uri);
    }

    /// <summary>A label that mixes Latin letters with letters of another script (a common look-alike trick).</summary>
    public static bool MixesScripts(string host)
    {
        foreach (var label in host.Split('.'))
        {
            var latin = label.Any(c => c is >= 'a' and <= 'z');
            var other = label.Any(c => c > 127 && char.IsLetter(c));
            if (latin && other) return true;
        }
        return false;
    }

    public static string DecodeHost(string host)
    {
        if (string.IsNullOrEmpty(host)) return "";
        try { return new IdnMapping().GetUnicode(host.ToLowerInvariant()); }
        catch (ArgumentException) { return host; }
    }

    /// <summary>True when the visible text looks like a host (or URL) that is not the link's real host.</summary>
    public static bool TextNamesOtherHost(string? text, string realHost)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        var t = text.Trim();
        string? candidate = null;
        if (Uri.TryCreate(t, UriKind.Absolute, out var u) && (u.Scheme is "http" or "https")) candidate = u.IdnHost;
        else if (!t.Contains(' ') && t.Contains('.') && Uri.TryCreate("https://" + t, UriKind.Absolute, out var u2) && u2.Host.Contains('.')) candidate = u2.IdnHost;
        if (candidate is null) return false;
        return !SameSite(candidate.ToLowerInvariant(), realHost.ToLowerInvariant());
    }

    private static bool SameSite(string a, string b) => a == b || a.EndsWith("." + b, StringComparison.Ordinal) || b.EndsWith("." + a, StringComparison.Ordinal);
}
