using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Tests;

public class AvatarRuleTests
{
    private const string Base = "https://mail.example.test";
    private const string Id = "11111111-2222-3333-4444-555555555555";
    private static AvatarBatchEntry Photo(string? scope = null) => new($"/v1/avatars/mailbox/{Id}.webp?v=2", "Ada", scope, null);
    private static AvatarBatchEntry Logo() => new(null, null, null, new AvatarInstitution("Org", $"/v1/organizations/{Id}/logo"));

    [Fact] public void No_entry_gives_none() =>
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", null, null, AvatarTrust.Gated, Base).Kind);

    [Fact] public void Same_institution_photo_shows_on_received_mail_without_verdict() =>
        Assert.Equal(AvatarKind.Photo, AvatarRule.Decide("a@b.test", "A", Photo(), null, AvatarTrust.Gated, Base).Kind);

    [Fact] public void Platform_photo_needs_verified_sender()
    {
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", Photo("platform"), null, AvatarTrust.Gated, Base).Kind);
        Assert.Equal(AvatarKind.Photo, AvatarRule.Decide("a@b.test", "A", Photo("platform"), new MessageAuth(null, true), AvatarTrust.Gated, Base).Kind);
    }

    [Fact] public void Logo_needs_verified_sender()
    {
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", Logo(), null, AvatarTrust.Gated, Base).Kind);
        Assert.Equal(AvatarKind.Logo, AvatarRule.Decide("a@b.test", "A", Logo(), new MessageAuth(null, true), AvatarTrust.Gated, Base).Kind);
    }

    [Fact] public void Warning_suppresses_everything_even_if_verified()
    {
        var auth = new MessageAuth("warning", true);
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", Photo(), auth, AvatarTrust.Gated, Base).Kind);
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", Logo(), auth, AvatarTrust.Gated, Base).Kind);
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@b.test", "A", Photo(), new MessageAuth(AuthWarned: true), AvatarTrust.Gated, Base).Kind);
    }

    [Fact] public void Open_trust_skips_the_gate()
    {
        Assert.Equal(AvatarKind.Photo, AvatarRule.Decide("a@b.test", "A", Photo("platform"), null, AvatarTrust.Open, Base).Kind);
        Assert.Equal(AvatarKind.Logo, AvatarRule.Decide("a@b.test", "A", Logo(), null, AvatarTrust.Open, Base).Kind);
    }

    [Theory]
    [InlineData("https://evil.example/v1/avatars/mailbox/11111111-2222-3333-4444-555555555555.webp")]
    [InlineData("//evil.example/v1/avatars/mailbox/11111111-2222-3333-4444-555555555555.webp")]
    [InlineData("/v1/avatars/mailbox/../../etc/passwd")]
    [InlineData("https://www.gravatar.com/avatar/abc")]
    [InlineData("/some/other/path.png")]
    [InlineData("")]
    public void Untrusted_urls_are_refused(string url) => Assert.Null(AvatarRule.TrustedUrl(url, Base));

    [Fact] public void Relative_and_absolute_api_urls_resolve()
    {
        Assert.Equal($"{Base}/v1/avatars/user/{Id}.webp", AvatarRule.TrustedUrl($"/v1/avatars/user/{Id}.webp", Base));
        Assert.Equal($"{Base}/v1/avatars/user/{Id}.webp", AvatarRule.TrustedUrl($"{Base}/v1/avatars/user/{Id}.webp", Base));
    }

    [Fact] public void Placeholder_is_stable_per_address_and_case_insensitive()
    {
        Assert.Equal(AvatarRule.Placeholder("Ada@Example.test", "Ada Lovelace"), AvatarRule.Placeholder("ada@example.test", "Ada Lovelace"));
        Assert.Equal("A", AvatarRule.Placeholder("x@y.test", "ada Lovelace").Initials);
        Assert.Equal("J", AvatarRule.Placeholder("jane.doe@y.test").Initials);
        Assert.Equal("?", AvatarRule.Placeholder("").Initials);
        Assert.Contains(AvatarRule.Placeholder("q@y.test").Background, AvatarRule.PlaceholderColors);
    }

    [Fact] public void Fnv1a_matches_the_published_vectors()
    {
        Assert.Equal(0x811C9DC5u, AvatarRule.Fnv1a(""));
        Assert.Equal(0xE40C292Cu, AvatarRule.Fnv1a("a"));
        Assert.Equal(0xBF9CF968u, AvatarRule.Fnv1a("foobar"));
    }

    [Fact] public void Drafts_and_sent_are_outgoing()
    {
        var folders = new List<ApiFolder> { new("Drafts", "Drafts", "drafts", 0, 1), new("Sent", "Sent", "sent", 0, 1), new("Inbox", "INBOX", null, 0, 1) };
        Assert.True(AvatarRule.IsOutgoingFolder("Drafts", folders));
        Assert.True(AvatarRule.IsOutgoingFolder("Sent", folders));
        Assert.False(AvatarRule.IsOutgoingFolder("INBOX", folders));
    }

    [Fact] public void Subject_is_first_recipient_in_sent_else_sender()
    {
        Assert.Equal(("bob@x.test", "Bob B"), AvatarRule.Subject("me@x.test", "Me", new[] { "Bob B <Bob@x.test>" }, true));
        Assert.Equal(("me@x.test", "Me"), AvatarRule.Subject("ME@x.test", "Me", new[] { "Bob B <bob@x.test>" }, false));
        Assert.Equal(("me@x.test", ""), AvatarRule.Subject("me@x.test", "me@x.test", null, true));
    }

    [Fact] public void Sent_folder_detection()
    {
        var folders = new List<ApiFolder> { new("Sent", "Sent", "\\Sent", 0, 3), new("Mine", "Mine", null, 0, 1) };
        Assert.True(AvatarRule.IsSentFolder("Sent", folders));
        Assert.False(AvatarRule.IsSentFolder("Mine", folders));
        Assert.True(AvatarRule.IsSentFolder("INBOX.Sent Items", new List<ApiFolder>()));
    }
}
