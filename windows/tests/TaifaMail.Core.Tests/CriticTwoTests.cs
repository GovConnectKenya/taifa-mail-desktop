using System.Net;
using System.Net.Http.Headers;
using TaifaMail.Core.Cache;
using TaifaMail.Core.Compose;
using TaifaMail.Core.Content;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.Security;
using TaifaMail.Core.ViewModels;
using static TaifaMail.Core.Tests.FakeHandler;

namespace TaifaMail.Core.Tests;

public class LinkAndFileNameTests
{
    [Fact] public void Link_text_map_is_keyed_by_the_url_webview_reports()
    {
        var map = HtmlBody.LinkTexts("<a href=\"HTTPS://Evil.Example\">https://bank.example.go.ke</a><a href='https://x.test/a%20b?q=1&amp;r=2'>go</a>");
        Assert.True(map.TryGetValue(HtmlBody.NormalizeUrl("https://evil.example/"), out var text));
        Assert.Equal("https://bank.example.go.ke", text);
        Assert.True(LinkSafety.Check("https://evil.example/", text).HostDiffersFromText);
        Assert.True(map.ContainsKey(HtmlBody.NormalizeUrl("https://x.test/a%20b?q=1&r=2")));
    }

    [Theory]
    [InlineData("page.html")] [InlineData("a.HTM")] [InlineData("x.svg")] [InlineData("m.mhtml")] [InlineData("help.chm")] [InlineData("a.application")]
    [InlineData("s.xll")] [InlineData("a.cab")] [InlineData("a.inf")] [InlineData("a.scf")] [InlineData("a.ws")] [InlineData("a.wsc")] [InlineData("a.sct")] [InlineData("a.vb")]
    [InlineData("a.diagcab")] [InlineData("a.settingcontent-ms")] [InlineData("a.library-ms")] [InlineData("a.search-ms")] [InlineData("a.appxbundle")] [InlineData("a.msixbundle")]
    [InlineData("a.website")] [InlineData("a.mst")] [InlineData("a.psc1")] [InlineData("a.ps1xml")] [InlineData("a.jar")] [InlineData("a.xhtml")] [InlineData("a.mht")]
    public void More_active_content_types_are_save_only(string name) => Assert.True(AttachmentSafety.IsRisky(name));

    [Fact] public void Long_names_keep_their_extension_and_never_split_a_surrogate_pair()
    {
        var name = new string('a', 119) + "\U0001F600" + new string('b', 40) + ".pdf";
        var safe = AttachmentSafety.SafeName(name);
        Assert.EndsWith(".pdf", safe);
        Assert.True(safe.Length <= 120);
        for (var i = 0; i < safe.Length; i++)
            if (char.IsHighSurrogate(safe[i])) Assert.True(i + 1 < safe.Length && char.IsLowSurrogate(safe[i + 1]));
        Assert.EndsWith(".docx", AttachmentSafety.SafeName(new string('z', 300) + ".docx"));
    }

    [Fact] public void Malformed_punycode_hosts_do_not_throw()
    {
        var c = LinkSafety.Check("https://xn--.example/");
        Assert.True(c.Allowed || !c.Allowed);
        Assert.NotNull(LinkSafety.Check("https://xn--a.example/"));
        Assert.Equal("xn--zzzzzzzzzzzzzzzz.example", LinkSafety.DecodeHost("xn--zzzzzzzzzzzzzzzz.example"));
    }
}

public class SendLockTests
{
    private sealed class Api : IComposeApi
    {
        public Exception? Throw; public bool NullReply; public int Sends;
        public Task<ApiSendResult> SendAsync(SendMailPayload p, CancellationToken ct = default)
        {
            Sends++;
            if (Throw is not null) throw Throw;
            return Task.FromResult(NullReply ? null! : new ApiSendResult(true, "<x>", null, null));
        }
        public Task<ApiDraftResult> SaveDraftAsync(SendMailPayload p, CancellationToken ct = default) => Task.FromResult(new ApiDraftResult(1, "Drafts"));
        public Task DeleteDraftAsync(long uid, string folder, CancellationToken ct = default) => Task.CompletedTask;
        public Task<string> UploadAsync(string n, string m, long s, Stream c, CancellationToken ct = default) => throw new IOException("cloud only file");
        public Task DeleteUploadAsync(string id, CancellationToken ct = default) => Task.CompletedTask;
        public Task<IReadOnlyList<string>> SuggestAsync(string q, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
        public Task<IReadOnlyList<string>> StageForwardAsync(long u, string f, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
    }

    private static ComposeViewModel Vm(Api api) { var vm = new ComposeViewModel(api, "me@x.test", ComposeSeeds.Blank()) { BodyProvider = () => ("<div>x</div>", "x\n") }; vm.AddRecipient(vm.To, "a@x.test"); return vm; }

    [Theory]
    [InlineData(500)] [InlineData(502)] [InlineData(503)]
    public async Task A_5xx_after_the_request_went_out_locks_sending_like_a_timeout(int status)
    {
        var api = new Api { Throw = new ApiRequestError("boom", status) };
        var vm = Vm(api);
        Assert.False(await vm.SendAsync());
        Assert.Equal(ComposeViewModel.UnconfirmedSend, vm.Error);
        Assert.False(vm.CanSend);
        Assert.False(await vm.SendAsync());
        Assert.Equal(1, api.Sends);
    }

    [Fact] public async Task A_bad_reply_or_an_empty_reply_also_locks_sending()
    {
        var bad = new Api { Throw = new ApiRequestError("x", 502, "bad_reply") };
        var v1 = Vm(bad);
        Assert.False(await v1.SendAsync());
        Assert.False(v1.CanSend);
        var empty = new Api { NullReply = true };
        var v2 = Vm(empty);
        Assert.False(await v2.SendAsync());
        Assert.Equal(ComposeViewModel.UnconfirmedSend, v2.Error);
    }

    [Fact] public async Task A_4xx_refusal_keeps_the_window_sendable()
    {
        var vm = Vm(new Api { Throw = new ApiRequestError("Bad recipient", 422) });
        Assert.False(await vm.SendAsync());
        Assert.Equal("Bad recipient", vm.Error);
        Assert.True(vm.CanSend);
    }

    [Fact] public async Task Any_exception_while_reading_or_uploading_ends_as_a_failed_chip()
    {
        var vm = Vm(new Api());
        await vm.AddAttachmentAsync("cloud.docx", "application/octet-stream", 3, new MemoryStream(new byte[3]));
        Assert.Equal(AttachmentState.Failed, vm.Attachments.Single().State);
        Assert.False(vm.CanSend);
    }
}

public class ImageAndCsrfTests
{
    private sealed class H : HttpMessageHandler
    {
        public Func<HttpRequestMessage, HttpResponseMessage> Reply = _ => new HttpResponseMessage(HttpStatusCode.OK);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct) => Task.FromResult(Reply(r));
    }

    [Fact] public async Task A_429_image_reports_its_retry_after()
    {
        var h = new H { Reply = _ => { var r = new HttpResponseMessage((HttpStatusCode)429); r.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(3)); return r; } };
        using var api = new TaifaApiClient("https://mail.example.test", null, h);
        var res = await api.FetchImageAsync("/v1/inbox/m/images/cap?u=x");
        Assert.Equal(429, res.Status);
        Assert.Equal(3, res.RetryAfterSeconds);
        Assert.Null(res.Bytes);
        h.Reply = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 1, 2 }) };
        Assert.Equal(2, (await api.FetchImageAsync("/v1/inbox/m/images/cap?u=x")).Bytes!.Length);
    }

    [Fact] public async Task A_csrf_invalid_on_refresh_refetches_the_token_and_retries_once()
    {
        var refreshes = 0;
        var expired = false;
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"fresh\"}", "tfm_csrf=fresh; Path=/"))
            .On("GET /v1/inbox/m/folders", r => refreshes >= 2 ? Json(HttpStatusCode.OK, "[]") : Json(HttpStatusCode.Unauthorized, "{}"))
            .On("POST /auth/mailbox/refresh", _ => ++refreshes == 1 ? Json(HttpStatusCode.Forbidden, "{\"detail\":{\"code\":\"csrf_invalid\"}}") : Json(HttpStatusCode.OK, "{}"));
        using var api = new TaifaApiClient("https://mail.example.test", null, h);
        api.SessionExpired += () => expired = true;
        await new MailApi(api, "m").FoldersAsync();
        Assert.False(expired);
        Assert.Equal(2, refreshes);
    }
}

public class ReorderAndCacheTests
{
    [Fact] public async Task A_thread_with_a_new_message_moves_up_and_the_open_row_keeps_its_identity()
    {
        var pages = new List<List<ApiConversationSummary>>
        {
            Enumerable.Range(1, 3).Select(i => OfflineCacheTests.Thread(i)).ToList(),
            new List<ApiConversationSummary> { OfflineCacheTests.Thread(3) with { Latest = OfflineCacheTests.Thread(3).Latest with { Uid = 30 } }, OfflineCacheTests.Thread(1), OfflineCacheTests.Thread(2) with { Latest = OfflineCacheTests.Thread(2).Latest with { Uid = 20 } } },
        };
        var n = 0;
        var api = new RecMail { Conversations = (f, o) => { var p = pages[Math.Min(n++, 1)]; return new ApiConversationList(f, p.Count, 50, 0, p); } };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        var open = vm.Threads[1];
        vm.SelectedThread = open;
        await vm.MergeFirstPageAsync();
        Assert.Equal(new[] { "t3", "t1", "t2" }, vm.Threads.Select(t => t.ThreadKey));
        Assert.Same(open, vm.Threads[2]);
        Assert.Same(open, vm.SelectedThread);
    }

    [Fact] public void A_save_that_started_before_a_wipe_is_dropped()
    {
        using var c = new OfflineCache(":memory:");
        var gen = c.Generation;
        c.Wipe();
        c.SaveThreads("m", "INBOX", new[] { OfflineCacheTests.Thread(1) }, 1, generation: gen);
        Assert.Null(c.LoadThreads("m", "INBOX"));
        c.SaveThreads("m", "INBOX", new[] { OfflineCacheTests.Thread(1) }, 1, generation: c.Generation);
        Assert.NotNull(c.LoadThreads("m", "INBOX"));
    }

    [Fact] public void A_corrupt_cache_file_is_recreated_not_fatal()
    {
        var path = Path.Combine(Path.GetTempPath(), "tm-corrupt-" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            File.WriteAllText(path, "this is not a sqlite database at all, just text that is long enough to be a header.......");
            using var c = OfflineCache.OpenOrRecreate(path);
            c.SaveFolders("m", new[] { new ApiFolder("Inbox", "INBOX", null, 1, 1) });
            Assert.Single(c.LoadFolders("m")!);
        }
        finally { Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); foreach (var f in new[] { path, path + "-wal", path + "-shm" }) try { File.Delete(f); } catch (IOException) { } }
    }
}
