using TaifaMail.Core.Realtime;

namespace TaifaMail.Core.Tests;

public class RealtimeTests
{
    [Theory]
    [InlineData("{\"type\":\"connected\",\"message\":\"x\"}", RealtimeKind.Connected)]
    [InlineData("{\"type\":\"pong\"}", RealtimeKind.Pong)]
    [InlineData("{\"type\":\"mailbox_message_new\",\"folder\":\"INBOX\",\"uid\":7}", RealtimeKind.NewMail)]
    [InlineData("{\"type\":\"mailbox_flags_changed\"}", RealtimeKind.FlagsChanged)]
    [InlineData("{\"type\":\"mailbox_message_moved\"}", RealtimeKind.MessageMoved)]
    [InlineData("{\"type\":\"mailbox_message_purged\"}", RealtimeKind.MessageDeleted)]
    [InlineData("{\"type\":\"something_new\"}", RealtimeKind.Other)]
    public void Classifies_events(string json, RealtimeKind kind) => Assert.Equal(kind, RealtimeParser.Parse(json)!.Kind);

    [Fact]
    public void Extracts_folder_and_uid()
    {
        var e = RealtimeParser.Parse("{\"type\":\"mailbox_message_new\",\"folder\":\"INBOX\",\"uid\":7}")!;
        Assert.Equal("INBOX", e.Folder);
        Assert.Equal(7, e.Uid);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("{\"nope\":1}")]
    public void Garbage_is_ignored(string json) => Assert.Null(RealtimeParser.Parse(json));

    [Fact]
    public void Backoff_grows_and_caps()
    {
        var rng = new Random(1);
        Assert.InRange(Backoff.Delay(0, rng).TotalMilliseconds, 1000, 1200);
        Assert.InRange(Backoff.Delay(3, rng).TotalMilliseconds, 8000, 9600);
        Assert.InRange(Backoff.Delay(40, rng).TotalMilliseconds, 30000, 36000);
    }

    [Fact]
    public void Socket_uri_uses_wss_and_cookie_token() =>
        Assert.Equal("wss://mail.example.test/ws/mailbox?token=__cookie__", RealtimeClient.SocketUri(new Uri("https://mail.example.test/")).ToString());
}

public class RealtimeScopeTests
{
    [Fact]
    public void Events_for_another_mailbox_are_ignored()
    {
        var e = RealtimeParser.Parse("{\"type\":\"mailbox_message_new\",\"mailbox_id\":\"AAA\"}")!;
        Assert.True(e.IsFor("aaa"));
        Assert.False(e.IsFor("bbb"));
        Assert.True(RealtimeParser.Parse("{\"type\":\"pong\"}")!.IsFor("anything"));
    }
}
