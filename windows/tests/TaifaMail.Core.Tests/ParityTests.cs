using System.Net;
using System.Text.Json;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Cache;
using TaifaMail.Core.Compose;
using TaifaMail.Core.Content;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.Notifications;
using TaifaMail.Core.Security;
using TaifaMail.Core.ViewModels;
using static TaifaMail.Core.Tests.FakeHandler;

namespace TaifaMail.Core.Tests;

/// <summary>A recording mail fake for the parity and security fixes.</summary>
internal class RecMail : IMailApi
{
    public string MailboxId => "m";
    public List<string> Calls = new();
    public bool Fail;
    public List<ApiFolder> FolderList = new() { new("Inbox", "INBOX", "\\Inbox", 2, 9), new("Sent", "Sent", "\\Sent", 0, 4), new("Junk", "Junk", "\\Junk", 1, 3), new("Trash", "Trash", "\\Trash", 0, 3), new("Archive", "Archive", "\\Archive", 0, 0) };
    public Func<string, int, ApiConversationList>? Conversations;
    public Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) => Task.FromResult(FolderList);
    public Task<ApiConversationList> ConversationsAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default)
    {
        Calls.Add($"conversations:{folder}:{offset}");
        return Task.FromResult(Conversations?.Invoke(folder, offset) ?? new ApiConversationList(folder, 3, limit, offset, Enumerable.Range(1, 3).Select(i => OfflineCacheTests.Thread(i, unread: i == 1)).ToList()));
    }
    public Task<ApiMailList> MessagesAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default)
    {
        Calls.Add($"messages:{folder}:{offset}");
        return Task.FromResult(new ApiMailList(folder, 1, limit, offset, new() { OfflineCacheTests.Thread(7).Latest with { Folder = folder } }));
    }
    public Task<ApiMailList> SearchAsync(string t, string f = "INBOX", int l = 50, int o = 0, CancellationToken ct = default)
    {
        Calls.Add($"search:{f}:{o}");
        return Task.FromResult(new ApiMailList(f, 80, l, o, new() { OfflineCacheTests.Thread(100 + o).Latest with { Folder = f } }, Incomplete: o == 0));
    }
    public Task<ApiConversationWindow> ConversationAsync(long u, string f, int l = 20, long? b = null, CancellationToken ct = default) =>
        Task.FromResult(new ApiConversationWindow(new() { new ApiMailDetail(u, f, 1, "S", "Ada", "ada@example.test", null, null, "2026-01-01T10:00:00Z", false, false, false, "<m>", null, null, "hi", null, null) }, 1, 1, false, 0));
    public Func<long, string, Task<ApiMarkReadResult>>? MarkRead;
    public Task<ApiMarkReadResult> MarkThreadReadAsync(long u, string f, CancellationToken ct = default) { Calls.Add($"markread:{f}:{u}"); return MarkRead?.Invoke(u, f) ?? Task.FromResult(new ApiMarkReadResult(1, true)); }
    public Task SetFlagsAsync(long u, string f, bool? s = null, bool? fl = null, CancellationToken ct = default) => Task.CompletedTask;
    public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> e, CancellationToken ct = default) => Task.FromResult(new AvatarBatchResponse(new()));
    public Func<string, ApiBatchResult, ApiBatchResult>? Shape;
    private Task<ApiBatchResult> Do(string name, string folder, IReadOnlyCollection<long> uids)
    {
        Calls.Add($"{name}:{folder}:{string.Join(',', uids)}");
        if (Fail) throw new ApiRequestError("no", 500);
        var r = new ApiBatchResult(true, uids.Count, uids.ToList(), null);
        return Task.FromResult(Shape?.Invoke(name, r) ?? r);
    }
    public Task<ApiBatchResult> BatchArchiveAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("archive", f, u);
    public Task<ApiBatchResult> BatchDeleteAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("delete", f, u);
    public Task<ApiBatchResult> BatchPermanentAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("permanent", f, u);
    public Task<ApiBatchResult> BatchSpamAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("spam", f, u);
    public Task<ApiBatchResult> BatchNotSpamAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("notspam", f, u);
    public Task<ApiBatchResult> BatchMoveAsync(string f, IReadOnlyCollection<long> u, string to, CancellationToken ct = default) => Do("move->" + to, f, u);
    public Task<ApiBatchResult> BatchFlagsAsync(string f, IReadOnlyCollection<long> u, bool? seen = null, bool? flagged = null, CancellationToken ct = default) => Do("flags", f, u);
    public Task<ApiResolved> ResolveAsync(string id, string folder, CancellationToken ct = default) => Task.FromResult(new ApiResolved(folder, 900));
}

public class ActionFolderTests
{
    private static ApiConversationSummary SentLatest(int i) =>
        OfflineCacheTests.Thread(i) with { Latest = OfflineCacheTests.Thread(i).Latest with { Folder = "Sent" } };

    [Fact] public async Task Actions_use_the_folder_the_list_was_loaded_for_not_the_latest_messages_folder()
    {
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, 1, 50, 0, new() { SentLatest(5) }) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        var row = vm.Threads.Single();
        Assert.Equal("Sent", row.Folder);
        Assert.Equal("INBOX", row.ActionFolder);
        await vm.ArchiveAsync(new[] { row });
        await vm.ToggleFlagAsync(new[] { row });
        Assert.Contains("archive:INBOX:5", api.Calls);
        Assert.Contains("flags:INBOX:5", api.Calls);
        Assert.DoesNotContain(api.Calls, c => c.Contains(":Sent:"));
    }

    [Fact] public async Task Mark_read_still_uses_the_latest_messages_folder()
    {
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, 1, 50, 0, new() { SentLatest(5) with { Unread = true } }) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        await vm.OpenAsync(vm.Threads.Single());
        Assert.Contains("markread:Sent:5", api.Calls);
        Assert.Equal(1, vm.Folders.First(f => f.Path == "INBOX").Unseen);
    }
}

public class ListAndSearchTests
{
    [Fact] public async Task Sent_uses_the_flat_message_list_and_inbox_uses_conversations()
    {
        var api = new RecMail();
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        await vm.LoadFolderAsync(vm.Folders.First(f => f.Path == "Sent"));
        Assert.Contains("conversations:INBOX:0", api.Calls);
        Assert.Contains("messages:Sent:0", api.Calls);
        Assert.DoesNotContain("conversations:Sent:0", api.Calls);
    }

    [Fact] public async Task Not_junk_goes_through_batch_not_spam()
    {
        var api = new RecMail();
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        await vm.LoadFolderAsync(vm.Folders.First(f => f.Path == "Junk"));
        Assert.True(vm.IsJunkFolder);
        await vm.NotJunkAsync(new[] { vm.Threads[0] });
        Assert.Contains(api.Calls, c => c.StartsWith("notspam:Junk"));
    }

    [Fact] public async Task All_folder_search_skips_junk_and_trash_and_single_folder_search_pages()
    {
        var api = new RecMail();
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        vm.SearchAllFolders = true;
        await vm.SearchAsync("budget");
        Assert.DoesNotContain(api.Calls, c => c.StartsWith("search:Junk") || c.StartsWith("search:Trash"));
        Assert.Contains(api.Calls, c => c.StartsWith("search:Sent"));
        Assert.Equal("Showing the newest matches only.", vm.SearchNote);

        api.Calls.Clear();
        vm.SearchAllFolders = false;
        await vm.SearchAsync("budget");
        Assert.True(vm.HasMore);
        await vm.LoadMoreAsync();
        Assert.Contains("search:INBOX:1", api.Calls);
    }
}

public class MergeAndOpenTests
{
    [Fact] public async Task Merge_keeps_row_identity_selection_and_adds_new_rows_on_top()
    {
        var pages = new List<List<ApiConversationSummary>>
        {
            Enumerable.Range(1, 3).Select(i => OfflineCacheTests.Thread(i, unread: false)).ToList(),
            new[] { 9, 1, 2, 3 }.Select(i => OfflineCacheTests.Thread(i, unread: i == 9)).ToList(),
        };
        var n = 0;
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, pages[Math.Min(n++, 1)].Count, 50, 0, pages[Math.Min(n - 1, 1)]) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        var second = vm.Threads[1];
        vm.SelectedThread = second;
        await vm.MergeFirstPageAsync();
        Assert.Equal(4, vm.Threads.Count);
        Assert.Equal("t9", vm.Threads[0].ThreadKey);
        Assert.Same(second, vm.Threads[2]);
        Assert.Same(second, vm.SelectedThread);
    }

    [Fact] public async Task A_cancelled_body_load_does_not_revert_a_thread_the_user_opened()
    {
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, 2, 50, 0, new() { OfflineCacheTests.Thread(1, true), OfflineCacheTests.Thread(2, true) }) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        var a = vm.Threads[0];
        var cts = new CancellationTokenSource();
        cts.Cancel();
        await vm.OpenAsync(a, cts.Token);
        Assert.False(a.Unread);
        Assert.Contains("markread:INBOX:1", api.Calls);
    }

    [Fact] public async Task Unread_counts_follow_the_threads_folder_not_the_selected_one()
    {
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, 1, 50, 0, new() { OfflineCacheTests.Thread(1, true) }) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        var row = vm.Threads[0];
        await vm.LoadFolderAsync(vm.Folders.First(f => f.Path == "Archive"));
        await vm.OpenAsync(row);
        Assert.Equal(1, vm.Folders.First(f => f.Path == "INBOX").Unseen);
        Assert.Equal(0, vm.Folders.First(f => f.Path == "Archive").Unseen);
    }
}

public class DeleteAndUndoTests
{
    [Fact] public async Task Delete_in_trash_asks_first_and_uses_permanent()
    {
        var api = new RecMail();
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        await vm.LoadFolderAsync(vm.Folders.First(f => f.Path == "Trash"));
        await vm.DeleteAsync(new[] { vm.Threads[0] });
        Assert.DoesNotContain(api.Calls, c => c.StartsWith("permanent"));
        var asked = 0;
        vm.ConfirmPermanentDelete = n => { asked = n; return Task.FromResult(true); };
        await vm.DeleteAsync(new[] { vm.Threads[0] });
        Assert.Equal(1, asked);
        Assert.Contains(api.Calls, c => c.StartsWith("permanent:Trash"));
    }

    [Fact] public async Task Undo_is_only_offered_for_single_message_rows()
    {
        var multi = OfflineCacheTests.Thread(1) with { Uids = new() { 1, 2 } };
        var api = new RecMail { Conversations = (f, o) => new ApiConversationList(f, 2, 50, 0, new() { multi, OfflineCacheTests.Thread(3) }) };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        Func<Task>? undo = null; string? msg = null;
        vm.Notice += (m, u) => { msg = m; undo = u; };
        await vm.ArchiveAsync(new[] { vm.Threads[0] });
        Assert.Equal("Archived", msg);
        Assert.Null(undo);
        await vm.ArchiveAsync(new[] { vm.Threads[0] });
        Assert.NotNull(undo);
    }

    [Fact] public async Task A_partial_batch_refreshes_and_reports_counts()
    {
        var api = new RecMail { Shape = (n, r) => r with { Ok = false, Succeeded = new() { 1 }, Failed = new() { new ApiBatchFailure(2, "move_failed") } } };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        string? msg = null;
        vm.Notice += (m, _) => msg = m;
        await vm.ArchiveAsync(new[] { vm.Threads[0], vm.Threads[1] });
        Assert.Equal("1 of 2 done. 1 could not be changed.", msg);
        Assert.DoesNotContain("Nothing was changed", msg);
    }
}

public class ClientRobustnessTests
{
    private static TaifaApiClient Client(HttpMessageHandler h) => new("https://mail.example.test", null, h);

    [Fact] public void Contacts_reply_is_a_bare_array_and_folder_counts_may_be_null()
    {
        var contacts = JsonSerializer.Deserialize<List<ApiContact>>("[{\"id\":\"1\",\"display_name\":\"Ada\",\"emails\":[{\"type\":\"work\",\"value\":\"ada@x.test\",\"primary\":true}]}]", TaifaJson.Options)!;
        Assert.Equal("ada@x.test", contacts[0].Emails![0].Value);
        var folders = JsonSerializer.Deserialize<List<ApiFolder>>("[{\"name\":\"Inbox\",\"path\":\"INBOX\",\"special_use\":null,\"unseen\":null,\"total\":null}]", TaifaJson.Options)!;
        Assert.Null(folders[0].Unseen);
    }

    [Fact] public async Task Bad_json_becomes_an_api_error_not_a_crash()
    {
        var h = new FakeHandler().On("GET /v1/inbox/m/folders", _ => Json(HttpStatusCode.OK, "[{\"name\":"));
        using var api = Client(h);
        var e = await Assert.ThrowsAsync<ApiRequestError>(() => new MailApi(api, "m").FoldersAsync());
        Assert.Equal("bad_reply", e.Code);
    }

    [Theory]
    [InlineData(401, TaifaApiClient.RefreshOutcome.Rejected)]
    [InlineData(403, TaifaApiClient.RefreshOutcome.Rejected)]
    [InlineData(429, TaifaApiClient.RefreshOutcome.Transient)]
    [InlineData(503, TaifaApiClient.RefreshOutcome.Transient)]
    [InlineData(200, TaifaApiClient.RefreshOutcome.Renewed)]
    public void Only_401_and_403_end_a_session(int status, TaifaApiClient.RefreshOutcome expected) =>
        Assert.Equal(expected, TaifaApiClient.Classify((HttpStatusCode)status));

    [Fact] public async Task A_failing_refresh_with_503_keeps_the_session()
    {
        var expired = false;
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("GET /v1/inbox/m/folders", _ => Json(HttpStatusCode.Unauthorized, "{\"detail\":\"x\"}"))
            .On("POST /auth/mailbox/refresh", _ => Json(HttpStatusCode.ServiceUnavailable, "{}"));
        using var api = Client(h);
        api.SessionExpired += () => expired = true;
        await Assert.ThrowsAsync<ApiTransportError>(() => new MailApi(api, "m").FoldersAsync());
        Assert.False(expired);
    }

    [Fact] public async Task Concurrent_401s_share_one_refresh()
    {
        var refreshes = 0;
        var gate = new TaskCompletionSource();
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("GET /v1/inbox/m/folders", r => r.Headers.Contains("Cookie") && refreshes > 0 ? Json(HttpStatusCode.OK, "[]", "x=1") : Json(HttpStatusCode.Unauthorized, "{}"))
            .On("POST /auth/mailbox/refresh", _ => { Interlocked.Increment(ref refreshes); return Json(HttpStatusCode.OK, "{}", "tfm_mb_access=B; Path=/"); });
        using var api = Client(h);
        var mail = new MailApi(api, "m");
        await Task.WhenAll(mail.FoldersAsync(), mail.FoldersAsync(), mail.FoldersAsync());
        Assert.Equal(1, refreshes);
    }

    [Fact] public async Task Csrf_retry_fetches_a_fresh_token_from_the_server_even_with_a_cookie()
    {
        var posts = 0;
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"fresh\"}", "tfm_csrf=fresh; Path=/"))
            .On("POST /v1/x", _ => ++posts == 1 ? Json(HttpStatusCode.Forbidden, "{\"detail\":{\"code\":\"csrf_invalid\"}}", "tfm_csrf=stale; Path=/") : Json(HttpStatusCode.OK, "{}"));
        using var api = Client(h);
        await api.PostAsync("/v1/x", new { });
        Assert.Equal(2, h.Requests.Count(r => r.PathAndQuery == "/auth/csrf"));
        Assert.Equal("fresh", h.Requests.Last().Csrf);
    }

    [Fact] public async Task Redirects_are_errors_and_cookies_never_go_to_other_hosts()
    {
        var h = new FakeHandler().On("GET /v1/inbox/m/folders", _ => Json(HttpStatusCode.Found, "{}"));
        using var api = Client(h);
        await Assert.ThrowsAsync<ApiRequestError>(() => new MailApi(api, "m").FoldersAsync());

        var store = new MemorySessionStore();
        store.Save("[{\"Name\":\"tfm_mb_access\",\"Value\":\"A\",\"Domain\":\"mail.example.test\",\"Path\":\"/\",\"Expires\":null,\"Secure\":false,\"HttpOnly\":false}]");
        var h2 = new FakeHandler().On("PUT /bucket/file", _ => Json(HttpStatusCode.OK, "{}"));
        using var api2 = new TaifaApiClient("https://mail.example.test", store, h2);
        await api2.PutPresignedAsync(new ApiUploadTarget("https://storage.example.net/bucket/file", "PUT", null), new MemoryStream(new byte[2]));
        Assert.Null(h2.Requests.Single().Cookie);
    }

    [Fact] public void Me_flags_drive_the_web_setup_screen()
    {
        var me = JsonSerializer.Deserialize<MailboxMe>("{\"mailbox_id\":\"m\",\"address\":\"a@x.test\",\"must_change_password\":true,\"needs_recovery_email\":false}", TaifaJson.Options)!;
        Assert.True(me.NeedsWebSetup);
        Assert.False(JsonSerializer.Deserialize<MailboxMe>("{\"mailbox_id\":\"m\",\"address\":\"a@x.test\"}", TaifaJson.Options)!.NeedsWebSetup);
    }
}

public class ComposeParityTests
{
    private sealed class Api : IComposeApi
    {
        public List<SendMailPayload> Sent = new(), Drafts = new();
        public List<long> Deleted = new();
        public Queue<string> Statuses = new(new[] { "scanning", "scanning", "ready" });
        public Task? SendHold; public bool TimeoutSend;
        public Task<ApiSendResult> SendAsync(SendMailPayload p, CancellationToken ct = default)
        { if (TimeoutSend) throw new ApiTransportError("timeout"); Sent.Add(p); return Task.FromResult(new ApiSendResult(true, "<x>", null, null)); }
        public Task<ApiDraftResult> SaveDraftAsync(SendMailPayload p, CancellationToken ct = default) { Drafts.Add(p); return Task.FromResult(new ApiDraftResult(100 + Drafts.Count, "Drafts")); }
        public Task DeleteDraftAsync(long uid, string folder, CancellationToken ct = default) { Deleted.Add(uid); return Task.CompletedTask; }
        public Task<string> UploadAsync(string n, string m, long s, Stream c, CancellationToken ct = default) => Task.FromResult("file-" + n);
        public Task DeleteUploadAsync(string id, CancellationToken ct = default) => Task.CompletedTask;
        public Task<string> FileStatusAsync(string id, CancellationToken ct = default) => Task.FromResult(Statuses.Count > 1 ? Statuses.Dequeue() : Statuses.Peek());
        public Task<IReadOnlyList<string>> SuggestAsync(string q, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
        public Task<IReadOnlyList<string>> StageForwardAsync(long u, string f, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
    }

    private static ComposeViewModel Vm(Api api) => new(api, "me@x.test", ComposeSeeds.Blank()) { BodyProvider = () => ("<div>hi</div>", "hi\n"), ScanPoll = TimeSpan.FromMilliseconds(1) };

    [Fact] public async Task Send_waits_for_the_virus_scan()
    {
        var api = new Api();
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        var upload = vm.AddAttachmentAsync("a.pdf", "application/pdf", 3, new MemoryStream(new byte[3]));
        Assert.False(vm.CanSend);
        await upload;
        Assert.Equal(AttachmentState.Ready, vm.Attachments[0].State);
        Assert.True(vm.CanSend);
    }

    [Fact] public async Task An_infected_file_blocks_sending_until_removed()
    {
        var api = new Api { Statuses = new(new[] { "infected" }) };
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        await vm.AddAttachmentAsync("bad.exe", "application/octet-stream", 3, new MemoryStream(new byte[3]));
        Assert.Equal(AttachmentState.Infected, vm.Attachments[0].State);
        Assert.False(vm.CanSend);
        await vm.RemoveAttachmentAsync(vm.Attachments[0]);
        Assert.True(vm.CanSend);
    }

    [Fact] public async Task Draft_saves_wait_for_scans_and_leave_unready_files_out()
    {
        var api = new Api();
        var vm = Vm(api);
        var upload = vm.AddAttachmentAsync("a.pdf", "application/pdf", 3, new MemoryStream(new byte[3]));
        await vm.SaveDraftNowAsync();
        await upload;
        Assert.Equal(new[] { "file-a.pdf" }, api.Drafts.Single().FileIds);
    }

    [Fact] public async Task A_timed_out_send_is_not_retried_and_does_not_save_a_draft_on_close()
    {
        var api = new Api { TimeoutSend = true };
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        Assert.False(await vm.SendAsync());
        Assert.Equal(ComposeViewModel.UnconfirmedSend, vm.Error);
        Assert.False(vm.CanSend);
        await vm.SaveOnCloseAsync();
        Assert.Empty(api.Drafts);
        Assert.Empty(api.Sent);
    }

    [Fact] public async Task Send_trashes_the_final_stored_draft()
    {
        var api = new Api();
        var vm = Vm(api);
        vm.AddRecipient(vm.To, "ada@x.test");
        await vm.SaveDraftNowAsync();
        await vm.SaveDraftNowAsync();
        Assert.True(await vm.SendAsync());
        Assert.Equal(new long[] { 102 }, api.Deleted);
    }
}

public class AutoReplyFormTests
{
    private static readonly ApiAutoResponder Orig = new(true, "Away", "<p>Original <b>html</b></p>", "Original html", "always", "2026-01-01T00:00:00+03:00", "2026-02-01T23:59:59+03:00", new() { 0, 1 }, 9, 17);

    [Fact] public void Unchanged_text_keeps_the_stored_html_and_other_modes_keep_the_dates()
    {
        var (c, err) = AutoReplyForm.Build(Orig, true, "Away", "Original html", "outside_hours", null, null, 9, 17);
        Assert.Null(err);
        Assert.Equal(Orig.Html, c!.Html);
        Assert.Equal(Orig.StartAt, c.StartAt);
        Assert.Equal(Orig.EndAt, c.EndAt);
    }

    [Fact] public void Edited_text_regenerates_html()
    {
        var (c, _) = AutoReplyForm.Build(Orig, true, "Away", "New <text>", "always", null, null, 9, 17);
        Assert.Equal("New &lt;text&gt;", c!.Html);
    }

    [Fact] public void Date_range_end_is_inclusive_and_both_dates_are_required()
    {
        Assert.NotNull(AutoReplyForm.Build(Orig, true, "s", "t", "date_range", new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero), null, 9, 17).Error);
        var (c, err) = AutoReplyForm.Build(Orig, true, "s", "t", "date_range", new DateTimeOffset(2026, 3, 1, 5, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 3, 5, 5, 0, 0, TimeSpan.Zero), 9, 17);
        Assert.Null(err);
        Assert.Equal("2026-03-01T00:00:00.0000000+03:00", c!.StartAt);
        Assert.Equal("2026-03-05T23:59:59.0000000+03:00", c.EndAt);
        Assert.NotNull(AutoReplyForm.Build(Orig, true, "s", "t", "date_range", new DateTimeOffset(2026, 3, 5, 0, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero), 9, 17).Error);
    }

    [Fact] public void Hours_are_clamped_to_23() => Assert.Equal(23, AutoReplyForm.Build(Orig, false, "s", "t", "always", null, null, 9, 24).Config!.EndHour);

    [Fact] public void Structured_signatures_are_detected_and_html_is_stripped_to_text()
    {
        var plain = JsonSerializer.Deserialize<ApiMailBlock>("{\"id\":\"1\",\"block_type\":\"signature\",\"name\":\"s\",\"html\":\"<p>Hi</p>\",\"text\":null,\"is_default\":true,\"config\":null}", TaifaJson.Options)!;
        var built = JsonSerializer.Deserialize<ApiMailBlock>("{\"id\":\"2\",\"block_type\":\"signature\",\"name\":\"s\",\"html\":\"<p>Hi</p>\",\"text\":null,\"is_default\":true,\"config\":{\"layout\":\"card\"}}", TaifaJson.Options)!;
        Assert.False(plain.IsStructured);
        Assert.True(built.IsStructured);
        Assert.Equal("Hi\nThere", HtmlText.Strip("<p>Hi</p><p>There</p>"));
    }
}

public class SecurityTests
{
    [Theory]
    [InlineData("setup.exe", true)] [InlineData("invoice.pdf.exe", true)] [InlineData("macro.XLSM", true)] [InlineData("disk.iso", true)] [InlineData("run.ps1", true)]
    [InlineData("notes.pdf", false)] [InlineData("photo.jpg", false)]
    public void Risky_types_are_save_only(string name, bool risky) => Assert.Equal(risky, AttachmentSafety.IsRisky(name));

    [Fact] public void Safe_names_strip_bidi_trailing_dots_and_reserved_device_names()
    {
        Assert.Equal("invoicefdp.exe", AttachmentSafety.SafeName("invoice‮fdp.exe"));
        Assert.Equal("report.pdf", AttachmentSafety.SafeName("report.pdf. . "));
        Assert.Equal("_CON.txt", AttachmentSafety.SafeName("CON.txt"));
        Assert.Equal("_nul", AttachmentSafety.SafeName("nul"));
        Assert.Equal("a_b.txt", AttachmentSafety.SafeName("a/b.txt"));
        Assert.Equal("attachment", AttachmentSafety.SafeName("..."));
    }

    [Fact] public void Zone_identifier_names_zone_3_and_the_origin() =>
        Assert.Equal("[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://mail.govconnect.ke\r\nHostUrl=https://mail.govconnect.ke\r\n", AttachmentSafety.ZoneIdentifier("https://mail.govconnect.ke"));

    [Fact] public void Remote_images_are_rewritten_to_the_proxy_and_other_loads_are_left_alone()
    {
        var html = "<img src=\"https://t.example/a.png?x=1&amp;y=2\"><div style=\"background:url(http://t.example/b)\"></div><img src=\"data:image/png;base64,AA\">";
        var outHtml = ImageProxy.Rewrite(html, "https://mail.example.test", "mb1", "CAP");
        Assert.Contains("https://mail.example.test/v1/inbox/mb1/images/CAP?u=" + ImageProxy.Base64Url("https://t.example/a.png?x=1&y=2"), outHtml);
        Assert.Contains("background:url(http://t.example/b)", outHtml);
        Assert.Contains("data:image/png;base64,AA", outHtml);
        Assert.DoesNotContain("src=\"https://t.example", outHtml);
        Assert.True(ImageProxy.IsProxyRequest(new Uri("https://mail.example.test/v1/inbox/mb1/images/CAP?u=x"), "https://mail.example.test", "mb1"));
        Assert.False(ImageProxy.IsProxyRequest(new Uri("https://evil.example/v1/inbox/mb1/images/CAP"), "https://mail.example.test", "mb1"));
    }

    [Fact] public void Non_ascii_and_mixed_script_hosts_show_both_forms()
    {
        Assert.True(LinkSafety.Check("https://xn--mnchen-3ya.example/").ShowBothForms);
        Assert.False(LinkSafety.Check("https://example.go.ke/").ShowBothForms);
        Assert.True(LinkSafety.MixesScripts("pаypal.com"));
    }

    [Fact] public void Any_auth_warning_level_counts_as_warned_and_blocks_trusted_image_auto_allow()
    {
        var detail = new ApiMailDetail(1, "INBOX", 1, "s", "A", "a@x.test", null, null, "2026-01-01T10:00:00Z", true, false, false, "<1>", null, null, "t", "<p>x</p>", null, new ApiAuthWarning("info", null, "t", "m", false), true);
        var card = new MessageCardVm(detail, "me@x.test", true);
        Assert.True(card.Auth.AuthWarned);
        Assert.True(card.HasAuthBanner);
        Assert.Equal(AvatarKind.None, AvatarRule.Decide("a@x.test", "A", new AvatarBatchEntry("/v1/avatars/user/11111111-2222-3333-4444-555555555555.webp", null, "platform", null), card.Auth, AvatarTrust.Gated, "https://mail.example.test").Kind);
    }

    [Fact] public void Toasts_hide_the_subject_of_warned_mail_and_respect_the_preview_setting()
    {
        var warned = OfflineCacheTests.Thread(10).Latest with { AuthLevel = "warning", Subject = "Secret" };
        var ok = OfflineCacheTests.Thread(11).Latest with { Subject = "Budget" };
        var t = NotifyPolicy.Decide(new[] { warned, ok }, 5, "me@x.test", true).Toasts;
        Assert.Equal("New message", t[0].Subject);
        Assert.Equal("Budget", t[1].Subject);
        var generic = NotifyPolicy.Decide(new[] { ok }, 5, "me@x.test", true, showPreview: false).Toasts.Single();
        Assert.Equal(("Taifa Mail", "New message"), (generic.Sender, generic.Subject));
    }

    [Fact] public void Large_documents_do_not_fit_navigate_to_string() =>
        Assert.False(HtmlBody.FitsNavigateToString(new string('a', 1_100_000)));

    private sealed class XorProtector : ICacheProtector
    {
        public byte[] Protect(byte[] d) => d.Select(b => (byte)(b ^ 0x5A)).ToArray();
        public byte[] Unprotect(byte[] d) => Protect(d);
    }

    [Fact] public void The_cache_is_unreadable_without_the_key_and_wipe_removes_the_files()
    {
        var path = Path.Combine(Path.GetTempPath(), "tm-cache-" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            var c = new OfflineCache(path, new XorProtector());
            c.SaveThreads("m", "INBOX", new[] { OfflineCacheTests.Thread(1) with { Latest = OfflineCacheTests.Thread(1).Latest with { Subject = "Quarterly secret budget" } } }, 1);
            Assert.Equal("Quarterly secret budget", c.LoadThreads("m", "INBOX")!.Value.Items.Single().Latest.Subject);
            c.Dispose();
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            var raw = File.ReadAllBytes(path);
            Assert.DoesNotContain("Quarterly secret budget", System.Text.Encoding.UTF8.GetString(raw));

            var again = new OfflineCache(path, new XorProtector());
            again.Wipe();
            Assert.Null(again.LoadThreads("m", "INBOX"));
            again.Dispose();
        }
        finally { Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); foreach (var f in new[] { path, path + "-wal", path + "-shm" }) try { File.Delete(f); } catch (IOException) { } }
    }

    [Fact] public void Remembered_address_survives_sign_out_only_when_ticked()
    {
        var s = new LocalSettings();
        s.ApplySignIn("m", "a@x.test", remember: false);
        Assert.Null(s.RememberedAddress);
        s.ClearSession();
        Assert.Null(s.LastAddress);
        Assert.Null(s.LastMailboxId);
        s.ApplySignIn("m", "a@x.test", remember: true);
        s.ClearSession();
        Assert.Equal("a@x.test", s.RememberedAddress);
        Assert.Null(s.LastAddress);
        Assert.True(s.ShowNotificationPreview);
    }
}
