using System.Text;
using System.Text.RegularExpressions;

namespace TaifaMail.Core.Security;

/// <summary>File name hygiene and the open policy for attachments.</summary>
public static class AttachmentSafety
{
    private static readonly HashSet<string> RiskyExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".msi", ".msp", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".scr", ".lnk", ".url", ".pif",
        ".iso", ".img", ".vhd", ".vhdx", ".one", ".docm", ".xlsm", ".pptm", ".dotm", ".xlam", ".jar", ".reg", ".cpl", ".dll", ".sys", ".msc", ".gadget", ".appx", ".msix", ".appinstaller",
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
        return s.Length > 120 ? s[..120] : s;
    }

    /// <summary>Contents of the Zone.Identifier stream: ZoneId 3 (Internet) with the origin as host and referrer.</summary>
    public static string ZoneIdentifier(string origin) => $"[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl={origin}\r\nHostUrl={origin}\r\n";
}
