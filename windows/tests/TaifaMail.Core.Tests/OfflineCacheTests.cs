using TaifaMail.Core.Cache;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Tests;

public class OfflineCacheTests
{
    internal static ApiConversationSummary Thread(int i, bool unread = false) => new($"t{i}",
        new ApiMailSummary(i, "INBOX", $"<{i}@x.test>", $"Subject {i}", "Ada", "ada@example.test", new() { "me@example.test" }, "2026-01-01T10:00:00Z", !unread, false, false, false, "snippet"),
        1, unread, new() { i });

    [Fact]
    public void Round_trips_folders_and_threads_per_mailbox()
    {
        using var c = new OfflineCache(":memory:");
        c.SaveFolders("m1", new[] { new ApiFolder("Inbox", "INBOX", "\\Inbox", 2, 10) });
        c.SaveThreads("m1", "INBOX", new[] { Thread(1, true), Thread(2) }, 42);
        Assert.Equal("INBOX", c.LoadFolders("m1")!.Single().Path);
        var (items, total) = c.LoadThreads("m1", "INBOX")!.Value;
        Assert.Equal(new[] { "t1", "t2" }, items.Select(i => i.ThreadKey));
        Assert.Equal(42, total);
        Assert.True(items[0].Unread);
        Assert.Null(c.LoadThreads("m2", "INBOX"));
    }

    [Fact]
    public void Save_replaces_the_page_and_caps_it()
    {
        using var c = new OfflineCache(":memory:");
        c.SaveThreads("m", "INBOX", Enumerable.Range(0, 10).Select(i => Thread(i)).ToList(), 10, keep: 3);
        Assert.Equal(3, c.LoadThreads("m", "INBOX")!.Value.Items.Count);
        c.SaveThreads("m", "INBOX", new[] { Thread(99) }, 1);
        Assert.Equal("t99", c.LoadThreads("m", "INBOX")!.Value.Items.Single().ThreadKey);
    }

    [Fact]
    public void Clear_removes_everything()
    {
        using var c = new OfflineCache(":memory:");
        c.SaveFolders("m", new[] { new ApiFolder("Inbox", "INBOX", null, 0, 0) });
        c.SaveThreads("m", "INBOX", new[] { Thread(1) }, 1);
        c.Clear();
        Assert.Null(c.LoadFolders("m"));
        Assert.Null(c.LoadThreads("m", "INBOX"));
    }
}
