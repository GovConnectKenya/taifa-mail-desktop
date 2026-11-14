using System.Text;
using System.Text.RegularExpressions;

namespace TaifaMail.Core.Security;

/// <summary>File name hygiene and the open policy for attachments.</summary>
public static class AttachmentSafety
{
    private static readonly HashSet<string> RiskyExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".msi", ".msp", ".mst", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".ps1xml", ".psc1", ".vbs", ".vbe", ".vb", ".js", ".jse", ".wsf", ".wsh", ".ws", ".wsc", ".sct", ".hta", ".scr", ".lnk", ".url", ".website", ".pif",
        ".iso", ".img", ".vhd", ".vhdx", ".one", ".docm", ".xlsm", ".pptm", ".dotm", ".xlam", ".xll", ".jar", ".reg", ".cpl", ".dll", ".sys", ".msc", ".gadget", ".inf", ".scf", ".cab", ".diagcab", ".chm",
        ".html", ".htm", ".xhtml", ".svg", ".mht", ".mhtml", ".application", ".settingcontent-ms", ".library-ms", ".search-ms",
        ".appx", ".appxbundle", ".msix", ".msixbundle", ".appinstaller",
    };

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>Executables, scripts, containers and macro documents: Save only, never opened directly from the app.</summary>
    public static bool IsRisky(string filename)
    {
        var clean = SafeName(filename);
        // double extensions such as invoice.pdf.exe are judged by the last extension
        return RiskyExtensions.Contains(Path.GetExtension(clean));
    }

    /// <summary>Removes bidi controls, path characters, trailing dots and spaces, and neutralises reserved device names.</summary>
    public static string SafeName(string? name)
    {
        var sb = new StringBuilder();
        foreach (var ch in name ?? "")
        {
            if (ch is >= '\u202A' and <= '\u202E' or >= '\u2066' and <= '\u2069' or '\u200E' or '\u200F' or '\u061C') continue;
            if (char.IsControl(ch)) continue;
            sb.Append(Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch);
        }
        var s = sb.ToString().TrimEnd('.', ' ').TrimStart(' ');
        if (s.Length == 0) return "attachment";
        var stem = Path.GetFileNameWithoutExtension(s);
        if (ReservedNames.Contains(stem.TrimEnd('.', ' '))) s = "_" + s;
        return Truncate(s, 120);
    }

    /// <summary>Shortens the stem, never the extension, and never splits a surrogate pair.</summary>
    public static string Truncate(string s, int max)
    {
        if (s.Length <= max) return s;
        var ext = Path.GetExtension(s);
        if (ext.Length > 16) ext = ext[..16];
        var keep = Math.Max(1, max - ext.Length);
        var stem = Path.GetFileNameWithoutExtension(s);
        if (keep < stem.Length)
        {
            var cut = keep;
            if (char.IsHighSurrogate(stem[cut - 1])) cut--;
            stem = stem[..Math.Max(1, cut)];
        }
        return stem + ext;
    }

    /// <summary>Contents of the Zone.Identifier stream: ZoneId 3 (Internet) with the origin as host and referrer.</summary>
    public static string ZoneIdentifier(string origin) => $"[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl={origin}\r\nHostUrl={origin}\r\n";
}
