namespace TaifaMail.Core.ViewModels;

public static class TimeLabel
{
    /// <summary>Time of day today, weekday inside the last week, otherwise a short date.</summary>
    public static string ForList(DateTimeOffset when, DateTimeOffset now)
    {
        var w = when.ToLocalTime();
        var n = now.ToLocalTime();
        if (w.Date == n.Date) return w.ToString("HH:mm", System.Globalization.CultureInfo.CurrentCulture);
        if ((n.Date - w.Date).TotalDays == 1) return "Yesterday";
        if ((n.Date - w.Date).TotalDays is > 1 and < 7) return w.ToString("ddd", System.Globalization.CultureInfo.CurrentCulture);
        if (w.Year == n.Year) return w.ToString("d MMM", System.Globalization.CultureInfo.CurrentCulture);
        return w.ToString("d MMM yyyy", System.Globalization.CultureInfo.CurrentCulture);
    }
}
