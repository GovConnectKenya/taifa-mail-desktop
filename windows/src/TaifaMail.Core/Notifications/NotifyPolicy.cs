using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Notifications;

public sealed record ToastInfo(string Sender, string Subject, string Folder, long Uid);

public sealed record NotifyDecision(IReadOnlyList<ToastInfo> Toasts, long HighWater);

/// <summary>
/// Which messages deserve a toast. Input is the newest Inbox page confirmed over REST (never just a socket
/// event, API contract section 8). A toast needs: Inbox, still unread, not sent by the user, newer than the
/// last uid already handled, and alerts switched on. The first look after launch or a mailbox switch only
/// records the high water mark, so opening the app never replays old mail.
/// </summary>
public static class NotifyPolicy
{
    public static NotifyDecision Decide(IReadOnlyList<ApiMailSummary> inboxNewest, long? highWater, string ownAddress, bool alertsEnabled)
    {
        var top = inboxNewest.Where(m => IsInbox(m.Folder)).Select(m => m.Uid).DefaultIfEmpty(0).Max();
        if (highWater is null) return new NotifyDecision(Array.Empty<ToastInfo>(), top);
        var own = AvatarRule.NormalizeAddress(ownAddress);
        var toasts = alertsEnabled
            ? inboxNewest
                .Where(m => IsInbox(m.Folder) && !m.Seen && m.Uid > highWater && AvatarRule.NormalizeAddress(m.FromAddr) != own)
                .OrderBy(m => m.Uid)
                .Select(m => new ToastInfo(string.IsNullOrWhiteSpace(m.FromName) ? m.FromAddr : m.FromName.Trim(), m.Subject.Length > 0 ? m.Subject : "(no subject)", m.Folder, m.Uid))
                .ToList()
            : new List<ToastInfo>();
        return new NotifyDecision(toasts, Math.Max(highWater.Value, top));
    }

    private static bool IsInbox(string folder) => string.Equals(folder, "INBOX", StringComparison.OrdinalIgnoreCase);

    /// <summary>Taskbar badge text for the Inbox unread count: empty clears it, 99+ caps it.</summary>
    public static string BadgeLabel(int unread, bool badgeEnabled) => !badgeEnabled || unread <= 0 ? "" : unread > 99 ? "99+" : unread.ToString();

    /// <summary>Several arrivals at once collapse to one summary toast so a burst never floods the shell.</summary>
    public static IReadOnlyList<ToastInfo> Collapse(IReadOnlyList<ToastInfo> toasts, int max = 3)
    {
        if (toasts.Count <= max) return toasts;
        var shown = toasts.Take(max - 1).ToList();
        shown.Add(new ToastInfo($"{toasts.Count - shown.Count} more new messages", "Open Taifa Mail to read them", toasts[0].Folder, toasts[^1].Uid));
        return shown;
    }
}
