using TaifaMail.Core.Compose;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.Tests;

public class ComposeSeedTests
{
    private static ApiMailDetail Msg(string from = "ada@x.test", List<string>? to = null, List<string>? cc = null, string subject = "Budget") =>
        new(7, "INBOX", 1, subject, "Ada", from, to ?? new() { "me@x.test", "bob@x.test" }, cc ?? new() { "cy@x.test" }, "2026-01-01T10:00:00Z", true, false, false, "<m7@x>", null, "<m1@x>", "hello", null, new() { new("2", "a.pdf", "application/pdf", 10) });

    [Fact] public void Reply_goes_to_the_sender_with_threading_headers()
    {
        var s = ComposeSeeds.For(ComposeMode.Reply, Msg(), "me@x.test");
        Assert.Equal(new[] { "ada@x.test" }, s.To);
        Assert.Empty(s.Cc);
        Assert.Equal("Re: Budget", s.Subject);
        Assert.Equal("<m7@x>", s.InReplyTo);
        Assert.Equal("<m1@x> <m7@x>", s.References);
        Assert.Equal((7, "INBOX"), (s.ReplyUid, s.ReplyFolder));
    }

    [Fact] public void Reply_all_keeps_everyone_once_without_me()
    {
        var s = ComposeSeeds.For(ComposeMode.ReplyAll, Msg(), "ME@x.test");
        Assert.Equal(new[] { "bob@x.test", "cy@x.test" }, s.Cc);
    }

    [Fact] public void Reply_to_my_own_message_goes_to_its_recipients() =>
        Assert.Equal(new[] { "me@x.test", "bob@x.test" }, ComposeSeeds.For(ComposeMode.Reply, Msg(from: "me@x.test", to: new() { "me@x.test", "bob@x.test" }), "me@x.test").To);

    [Fact] public void Prefixes_are_not_doubled_and_forward_keeps_attachments()
    {
        Assert.Equal("Re: Budget", ComposeSeeds.For(ComposeMode.Reply, Msg(subject: "Re: Budget"), "me@x.test").Subject);
        var f = ComposeSeeds.For(ComposeMode.Forward, Msg(), "me@x.test");
        Assert.Equal("Fwd: Budget", f.Subject);
        Assert.Empty(f.To);
        Assert.Single(f.ForwardAttachments!);
    }
}

public class ComposeHtmlTests
{
    [Fact] public void Formatting_lists_and_links_become_html_and_text()
    {
        var paras = new List<ComposeParagraph>
        {
            new(new[] { new ComposeRun("Hi "), new ComposeRun("there", Bold: true), new ComposeRun(" <ok>", Italic: true) }),
            new(new[] { new ComposeRun("one") }, ListKind.Bullet),
            new(new[] { new ComposeRun("two") }, ListKind.Bullet),
            new(new[] { new ComposeRun("site", Link: "https://example.go.ke/a") }),
            new(new[] { new ComposeRun("bad", Link: "javascript:alert(1)") }),
        };
        var html = ComposeHtml.ToHtml(paras);
        Assert.Contains("<strong>there</strong>", html);
        Assert.Contains("<em> &lt;ok&gt;</em>", html);
        Assert.Contains("<ul><li>one</li><li>two</li></ul>", html);
        Assert.Contains("<a href=\"https://example.go.ke/a\">site</a>", html);
        Assert.DoesNotContain("javascript:", html);
        Assert.Contains("- one\n- two\n", ComposeHtml.ToText(paras));
    }
}

public class ComposeViewModelTests
{
    private sealed class FakeApi : IComposeApi
    {
        public List<SendMailPayload> Sent = new(), Drafts = new();
        public List<long> Deleted = new();
        public bool FailSend;
        public Task<ApiSendResult> SendAsync(SendMailPayload p, CancellationToken ct = default)
        { if (FailSend) throw new ApiRequestError("Server said no", 502); Sent.Add(p); return Task.FromResult(new ApiSendResult(true, "<x>", new() { "blocked@x.test" }, null)); }
        public Task<ApiDraftResult> SaveDraftAsync(SendMailPayload p, CancellationToken ct = default) { Drafts.Add(p); return Task.FromResult(new ApiDraftResult(100 + Drafts.Count, "Drafts")); }
        public Task DeleteDraftAsync(long uid, string folder, CancellationToken ct = default) { Deleted.Add(uid); return Task.CompletedTask; }
        public Task<string> UploadAsync(string n, string m, long s, Stream c, CancellationToken ct = default) => Task.FromResult("file-" + n);
        public Task DeleteUploadAsync(string id, CancellationToken ct = default) => Task.CompletedTask;
        public Task<IReadOnlyList<string>> SuggestAsync(string q, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(new[] { "Ada <ada@x.test>" });
        public Task<IReadOnlyList<string>> StageForwardAsync(long u, string f, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(new[] { "staged-1" });
    }

    private static ComposeViewModel Vm(FakeApi api) => new(api, "me@x.test", ComposeSeeds.Blank()) { BodyProvider = () => ("<div>hi</div>", "hi\n") };

    [Fact] public void Chips_parse_names_and_flag_invalid_addresses()
    {
        var chips = ComposeViewModel.Parse("Ada <ada@x.test>; nope, bob@x.test");
        Assert.Equal(new[] { true, false, true }, chips.Select(c => c.Valid));
        Assert.Equal("Ada", chips[0].Display);
    }

    [Fact] public async Task Send_needs_a_valid_recipient_and_reports_suppressed()
    {
        var api = new FakeApi();
        var vm = Vm(api);
        Assert.False(vm.CanSend);
        vm.AddRecipient(vm.To, "ada@x.test");
        Assert.True(vm.CanSend);
        Assert.True(await vm.SendAsync());
        Assert.Equal("Not delivered to: blocked@x.test", vm.Notice);
        Assert.Equal(new[] { "ada@x.test" }, api.Sent.Single().To);
    }

    [Fact] public async Task Failed_send_keeps_the_window_open_with_the_server_message()
    {
        var vm = Vm(new FakeApi { FailSend = true });
        vm.AddRecipient(vm.To, "ada@x.test");
        Assert.False(await vm.SendAsync());
        Assert.Equal("Server said no", vm.Error);
        Assert.True(vm.CanSend);
    }

    [Fact] public async Task Discard_deletes_the_stored_draft_and_never_saves_one()
    {
        var api = new FakeApi();
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        await vm.SaveDraftNowAsync();
        Assert.Single(api.Drafts);
        await vm.DiscardAsync();
        Assert.Equal(new long[] { 101 }, api.Deleted);
        await vm.SaveOnCloseAsync();
        Assert.Single(api.Drafts);
    }

    [Fact] public async Task Resaving_replaces_the_previous_draft_copy()
    {
        var api = new FakeApi();
        var vm = Vm(api);
        await vm.SaveDraftNowAsync();
        await vm.SaveDraftNowAsync();
        Assert.Equal(101, api.Drafts[1].ReplaceUid);
    }

    [Fact] public async Task Attachments_block_send_until_uploaded()
    {
        var api = new FakeApi();
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        await vm.AddAttachmentAsync("a.pdf", "application/pdf", 3, new MemoryStream(new byte[3]));
        Assert.True(vm.CanSend);
        await vm.SendAsync();
        Assert.Equal(new[] { "file-a.pdf" }, api.Sent.Single().FileIds);
    }
}
