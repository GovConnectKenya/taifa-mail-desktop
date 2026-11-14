using System.Text;
using System.Text.RegularExpressions;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Avatars;

public enum AvatarKind { Photo, Logo, None }

public sealed record AvatarDecision(AvatarKind Kind, string? Url, string Label);

/// <summary>The server's verdict on one message. Every field may be absent.</summary>
public sealed record MessageAuth(string? AuthLevel = null, bool? SenderVerified = null, bool AuthWarned = false);

public enum AvatarTrust
{
    /// <summary>Received mail: the server verdict gates logos and cross institution photos.</summary>
    Gated,
    /// <summary>Sent mail, recipient chips, suggestions: the user chose the correspondent.</summary>
    Open,
}

/// <summary>
/// The one decision for what an avatar shows. Port of the mobile rule
/// (taifa-mail-mobile src/avatarDecision.ts): only pictures the Taifa API
/// returned, only on the API origin, and on received mail only when the server
/// verified the sender and raised no authentication warning.
/// </summary>
public static class AvatarRule
{
    /// <summary>Spec section 7 palette, identical in light and dark.</summary>
    public static readonly string[] PlaceholderColors = { "#006900", "#7A4B00", "#00555E", "#4A3B8F", "#8A2B55", "#2F5D8A", "#5A6B00", "#7B3F2A" };

    private static readonly Regex AvatarPath = new(
        @"^/v1/(avatars/(?:mailbox|user)/[0-9a-f-]{36}\.webp|organizations/[0-9a-f-]{36}/logo)(?:\?[\w=&.%-]*)?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool HasWarning(MessageAuth? auth) => auth is not null && (!string.IsNullOrEmpty(auth.AuthLevel) || auth.AuthWarned);

    public static bool IsSenderVerified(MessageAuth? auth) => auth is { SenderVerified: true } && !HasWarning(auth);

    public static string NormalizeAddress(string? address)
    {
        var raw = (address ?? "").Trim();
        var m = Regex.Match(raw, @"<([^<>]+)>\s*$");
        return (m.Success ? m.Groups[1].Value : raw).Trim().ToLowerInvariant();
    }

    /// <summary>A picture URL is trusted only when it is on the API origin and on a path the server serves pictures from.</summary>
    public static string? TrustedUrl(string? url, string apiBase)
    {
        var raw = (url ?? "").Trim();
        var b = apiBase.TrimEnd('/');
        if (raw.Length == 0 || b.Length == 0 || raw.StartsWith("//", StringComparison.Ordinal)) return null;
        string? path = raw.StartsWith('/') ? raw : raw.StartsWith(b + "/", StringComparison.Ordinal) ? raw[b.Length..] : null;
        if (path is null || !AvatarPath.IsMatch(path)) return null;
        return b + path;
    }

    public static AvatarDecision Decide(string address, string? name, AvatarBatchEntry? entry, MessageAuth? auth, AvatarTrust trust, string apiBase)
    {
        var label = !string.IsNullOrWhiteSpace(name) ? name!.Trim() : !string.IsNullOrWhiteSpace(address) ? address.Trim() : "?";
        var none = new AvatarDecision(AvatarKind.None, null, label);
        if (entry is null) return none;

        var photo = TrustedUrl(entry.Url, apiBase);
        var logo = TrustedUrl(entry.Institution?.LogoUrl, apiBase);

        if (trust == AvatarTrust.Open)
        {
            if (photo is not null) return new(AvatarKind.Photo, photo, label);
            if (logo is not null) return new(AvatarKind.Logo, logo, label);
            return none;
        }

        if (HasWarning(auth)) return none;
        var verified = IsSenderVerified(auth);
        if (photo is not null && (entry.UrlScope != "platform" || verified)) return new(AvatarKind.Photo, photo, label);
        if (verified && logo is not null) return new(AvatarKind.Logo, logo, label);
        return none;
    }

    /// <summary>FNV-1a 32 bit over the UTF-8 bytes of the lowercased address.</summary>
    public static uint Fnv1a(string text)
    {
        var h = 2166136261u;
        foreach (var b in System.Text.Encoding.UTF8.GetBytes(text)) { h ^= b; h = unchecked(h * 16777619u); }
        return h;
    }

    private static string FirstLetter(string text)
    {
        var trimmed = text.Trim();
        for (var i = 0; i < trimmed.Length; i += char.IsSurrogatePair(trimmed, i) ? 2 : 1)
        {
            var cp = char.ConvertToUtf32(trimmed, i);
            if (Rune.IsLetterOrDigit(new Rune(cp))) return char.ConvertFromUtf32(cp).ToUpperInvariant();
        }
        return "";
    }

    /// <summary>The no picture avatar: first letter of the name, else the address, on a colour fixed by the address.</summary>
    public static (string Initials, string Background) Placeholder(string address, string? name = null)
    {
        var key = NormalizeAddress(address);
        var letter = FirstLetter(name ?? "");
        if (letter.Length == 0) letter = FirstLetter(key);
        if (letter.Length == 0) letter = "?";
        var seed = key.Length > 0 ? key : (name ?? "").Trim().ToLowerInvariant();
        return (letter, PlaceholderColors[(int)(Fnv1a(seed) % (uint)PlaceholderColors.Length)]);
    }

    /// <summary>Who a message's avatar stands for: first recipient in Sent, otherwise the sender.</summary>
    public static (string Address, string Name) Subject(string fromAddr, string? from, IEnumerable<string>? to, bool outgoing)
    {
        if (outgoing && to is not null)
        {
            var first = to.FirstOrDefault(t => NormalizeAddress(t).Length > 0);
            if (first is not null)
            {
                var named = Regex.Match(first, "^\\s*\"?([^\"<]+?)\"?\\s*<[^<>]+>\\s*$");
                return (NormalizeAddress(first), named.Success ? named.Groups[1].Value.Trim() : "");
            }
        }
        var address = NormalizeAddress(fromAddr);
        var name = (from ?? "").Trim();
        return (address, string.Equals(name, address, StringComparison.OrdinalIgnoreCase) ? "" : name);
    }

    public static bool IsSentFolder(string? path, IEnumerable<ApiFolder> folders)
    {
        if (string.IsNullOrEmpty(path)) return false;
        var known = folders.FirstOrDefault(f => f.Path == path);
        if (known?.SpecialUse is { Length: > 0 } su) return su.Contains("sent", StringComparison.OrdinalIgnoreCase);
        return Regex.IsMatch(path.Trim(), @"^(inbox\.)?sent( items| mail| messages)?$", RegexOptions.IgnoreCase);
    }

    /// <summary>Sent and Drafts rows show the recipient, so the avatar stands for the correspondent the user chose.</summary>
    public static bool IsOutgoingFolder(string? path, IEnumerable<ApiFolder> folders)
    {
        if (IsSentFolder(path, folders)) return true;
        if (string.IsNullOrEmpty(path)) return false;
        var known = folders.FirstOrDefault(f => f.Path == path);
        if (known?.SpecialUse is { Length: > 0 } su) return su.Contains("draft", StringComparison.OrdinalIgnoreCase);
        return Regex.IsMatch(path.Trim(), @"^(inbox\.)?drafts?$", RegexOptions.IgnoreCase);
    }
}
