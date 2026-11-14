using System.Net;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.ViewModels;

/// <summary>Builds the auto-reply PUT body from the form. The rules follow the web settings page.</summary>
public static class AutoReplyForm
{
    public static readonly TimeSpan Kenya = TimeSpan.FromHours(3);

    public static DateTimeOffset StartOfDay(DateTimeOffset d) => new(d.Year, d.Month, d.Day, 0, 0, 0, Kenya);
    /// <summary>The end date is inclusive: 23:59:59 (+03:00) of that day.</summary>
    public static DateTimeOffset EndOfDay(DateTimeOffset d) => new(d.Year, d.Month, d.Day, 23, 59, 59, Kenya);

    public static (ApiAutoResponder? Config, string? Error) Build(ApiAutoResponder original, bool enabled, string subject, string text, string mode,
        DateTimeOffset? start, DateTimeOffset? end, int startHour, int endHour)
    {
        if (enabled && mode == "date_range" && (start is null || end is null)) return (null, "Choose both dates for a date range.");
        if (mode == "date_range" && start is { } s && end is { } e && e.Date < s.Date) return (null, "The end date must be on or after the start date.");
        text = text.Replace("\r\n", "\n").Replace('\r', '\n');
        // keep the stored HTML exactly unless the message text was edited
        var edited = !string.Equals(text, (original.Text ?? "").Replace("\r\n", "\n"), StringComparison.Ordinal);
        var html = edited ? WebUtility.HtmlEncode(text).Replace("\n", "<br>") : original.Html;
        return (original with
        {
            Enabled = enabled,
            Subject = subject,
            Text = text,
            Html = html,
            Mode = mode,
            // other modes round trip what is stored instead of nulling it
            StartAt = mode == "date_range" ? StartOfDay(start!.Value).ToString("o") : original.StartAt,
            EndAt = mode == "date_range" ? EndOfDay(end!.Value).ToString("o") : original.EndAt,
            StartHour = Math.Clamp(startHour, 0, 23),
            EndHour = Math.Clamp(endHour, 0, 23),
        }, null);
    }
}
