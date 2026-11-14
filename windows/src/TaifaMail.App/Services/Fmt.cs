using Microsoft.UI.Xaml;
using TaifaMail.Core.Models;
using TaifaMail.Core.ViewModels;
using Windows.UI.Text;

namespace TaifaMail.App.Services;

/// <summary>Small pure helpers used from x:Bind function bindings.</summary>
public static class Fmt
{
    // One definition: the font families live in Styles/Tokens.xaml.
    private static Microsoft.UI.Xaml.Media.FontFamily Medium => (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["TmFontMedium"];
    private static Microsoft.UI.Xaml.Media.FontFamily Semi => (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["TmFontSemi"];
    private static Microsoft.UI.Xaml.Media.FontFamily Regular => (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["TmFont"];

    /// <summary>Sender: 500 when read, 700 (the SemiBold file, the heaviest Google Sans ships) when unread.</summary>
    public static Microsoft.UI.Xaml.Media.FontFamily SenderFont(bool unread) => unread ? Semi : Medium;
    /// <summary>Subject: 400 when read, 600 when unread.</summary>
    public static Microsoft.UI.Xaml.Media.FontFamily SubjectFont(bool unread) => unread ? Semi : Regular;
    public static Thickness RowPad(bool compact) => new(20, compact ? 8 : 12, 20, compact ? 8 : 12);
    public static double AvatarSize(bool compact) => compact ? 32 : 36;
    public static Visibility ShowAndNot(bool a, bool b) => a && !b ? Visibility.Visible : Visibility.Collapsed;
    public static string Unreadline(int total, int unread) => unread > 0 ? $"{total:N0} \u00b7 {unread:N0} unread" : $"{total:N0}";
    public static string AttachmentLine(string size, TaifaMail.Core.Compose.AttachmentState state) => state switch { TaifaMail.Core.Compose.AttachmentState.Uploading => size + " \u00b7 Uploading", TaifaMail.Core.Compose.AttachmentState.Scanning => size + " \u00b7 Scanning", TaifaMail.Core.Compose.AttachmentState.Infected => size + " \u00b7 Blocked by the virus scan", TaifaMail.Core.Compose.AttachmentState.Failed => size + " \u00b7 Failed", _ => size };
    public static string CountBadge(int n) => n > 99 ? "99+" : n.ToString();

    public static FontWeight Weight(bool unread) => unread ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal;
    public static FontWeight Bold(bool unread) => unread ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal;
    public static Visibility Show(bool value) => value ? Visibility.Visible : Visibility.Collapsed;
    public static Microsoft.UI.Xaml.Controls.InfoBarSeverity AuthSeverity(string level) => level switch
    {
        "danger" => Microsoft.UI.Xaml.Controls.InfoBarSeverity.Error,
        "warning" => Microsoft.UI.Xaml.Controls.InfoBarSeverity.Warning,
        _ => Microsoft.UI.Xaml.Controls.InfoBarSeverity.Informational,
    };
    public static bool HasText(string? s) => !string.IsNullOrEmpty(s);
    public static Visibility Or(bool a, bool b) => a || b ? Visibility.Visible : Visibility.Collapsed;
    public static Visibility Hide(bool value) => value ? Visibility.Collapsed : Visibility.Visible;
    public static Visibility ShowIf(int count, int min) => count >= min ? Visibility.Visible : Visibility.Collapsed;
    public static Visibility ShowStr(string? s) => string.IsNullOrEmpty(s) ? Visibility.Collapsed : Visibility.Visible;
    public static string Time(DateTimeOffset when) => TimeLabel.ForList(when, DateTimeOffset.Now);
    public static string Long(DateTimeOffset when) => when == DateTimeOffset.MinValue ? "" : when.ToLocalTime().ToString("d MMM yyyy, HH:mm");
    public static string Badge(int count) => count > 99 ? "99+" : count.ToString();
    public static string FolderBadge(ApiFolder f) => f.SpecialUse is { } su && su.Contains("draft", StringComparison.OrdinalIgnoreCase) ? (f.Total is > 0 ? Badge(f.Total.Value) : "") : (f.Unseen is > 0 ? Badge(f.Unseen.Value) : "");
    /// <summary>File names shown in the UI never carry bidi controls or path characters.</summary>
    public static string SafeName(string name) => TaifaMail.Core.Security.AttachmentSafety.SafeName(name);
    public static string Size(long bytes) => MessageCardVm.FormatSize(bytes);
    public static string CountText(int n) => n.ToString();
    public static string IconFor(ApiFolder f)
    {
        var key = (f.SpecialUse ?? f.Path).ToLowerInvariant();
        if (f.Path == "INBOX" || key.Contains("inbox")) return "inbox";
        if (key.Contains("draft")) return "drafts";
        if (key.Contains("sent")) return "sent";
        if (key.Contains("archive")) return "archive";
        if (key.Contains("junk") || key.Contains("spam")) return "junk";
        if (key.Contains("trash") || key.Contains("deleted")) return "trash";
        return "folder";
    }
}
