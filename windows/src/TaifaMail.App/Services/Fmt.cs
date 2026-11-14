using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using TaifaMail.Core.Models;
using TaifaMail.Core.ViewModels;
using Windows.UI.Text;

namespace TaifaMail.App.Services;

/// <summary>Small pure helpers used from x:Bind function bindings.</summary>
public static class Fmt
{
    public static FontWeight Weight(bool unread) => unread ? FontWeights.SemiBold : FontWeights.Normal;
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
    public static string FolderBadge(ApiFolder f) => f.SpecialUse is { } su && su.Contains("draft", StringComparison.OrdinalIgnoreCase) ? (f.Total > 0 ? Badge(f.Total) : "") : (f.Unseen > 0 ? Badge(f.Unseen) : "");
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
