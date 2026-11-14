using TaifaMail.Core.Models;
using TaifaMail.Core.Notifications;

namespace TaifaMail.Core.Tests;

public class NotifyPolicyTests
{
    private static ApiMailSummary Mail(long uid, string from = "ada@example.go.ke", bool seen = false, string folder = "INBOX", string name = "Ada", string subject = "Hello") =>
        new(uid, folder, $"<{uid}@x>", subject, name, from, null, "2026-01-01T10:00:00Z", seen, false, false, false, "s");

    [Fact] public void First_look_records_the_high_water_mark_without_toasts()
    {
        var d = NotifyPolicy.Decide(new[] { Mail(5), Mail(9) }, null, "me@example.go.ke", true);
        Assert.Empty(d.Toasts);
        Assert.Equal(9, d.HighWater);
    }

    [Fact] public void New_unread_inbox_mail_toasts_once_and_advances()
    {
        var page = new[] { Mail(10), Mail(9), Mail(8) };
        var first = NotifyPolicy.Decide(page, 8, "me@example.go.ke", true);
        Assert.Equal(new long[] { 9, 10 }, first.Toasts.Select(t => t.Uid));
        Assert.Equal(10, first.HighWater);
        Assert.Empty(NotifyPolicy.Decide(page, first.HighWater, "me@example.go.ke", true).Toasts);
    }

    [Fact] public void Already_read_mail_does_not_toast() =>
        Assert.Empty(NotifyPolicy.Decide(new[] { Mail(10, seen: true) }, 5, "me@example.go.ke", true).Toasts);

    [Fact] public void Own_sent_mail_does_not_toast() =>
        Assert.Empty(NotifyPolicy.Decide(new[] { Mail(10, from: "Me <ME@example.go.ke>") }, 5, "me@example.go.ke", true).Toasts);

    [Fact] public void Other_folders_do_not_toast() =>
        Assert.Empty(NotifyPolicy.Decide(new[] { Mail(10, folder: "Junk") }, 5, "me@example.go.ke", true).Toasts);

    [Fact] public void Alerts_off_suppresses_toasts_but_still_advances()
    {
        var d = NotifyPolicy.Decide(new[] { Mail(10) }, 5, "me@example.go.ke", false);
        Assert.Empty(d.Toasts);
        Assert.Equal(10, d.HighWater);
    }

    [Fact] public void Toast_shows_sender_name_else_address_and_subject()
    {
        var t = NotifyPolicy.Decide(new[] { Mail(10, name: ""), Mail(11, name: "Brian", subject: "") }, 5, "me@example.go.ke", true).Toasts;
        Assert.Equal("ada@example.go.ke", t[0].Sender);
        Assert.Equal("Brian", t[1].Sender);
        Assert.Equal("(no subject)", t[1].Subject);
    }

    [Theory]
    [InlineData(0, true, "")]
    [InlineData(7, true, "7")]
    [InlineData(100, true, "99+")]
    [InlineData(7, false, "")]
    public void Badge_label(int unread, bool on, string expected) => Assert.Equal(expected, NotifyPolicy.BadgeLabel(unread, on));

    [Fact] public void A_burst_collapses_to_a_summary()
    {
        var toasts = Enumerable.Range(1, 7).Select(i => new ToastInfo("A", "S", "INBOX", i)).ToList();
        var c = NotifyPolicy.Collapse(toasts);
        Assert.Equal(3, c.Count);
        Assert.Contains("5 more", c[2].Sender);
    }
}
