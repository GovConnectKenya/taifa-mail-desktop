using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;

namespace TaifaMail.Core.Tests;

public class SignInViewModelTests
{
    private sealed class FakeAuth : IAuthApi
    {
        public LoginResult? Login; public LoginResult? Code; public LoginResult? Second; public Exception? Throw; public int Codes;
        public Task<LoginResult> LoginAsync(string a, string p, CancellationToken ct = default) => Throw is null ? Task.FromResult(Login!) : Task.FromException<LoginResult>(Throw);
        public Task RequestLoginCodeAsync(string a, CancellationToken ct = default) { Codes++; return Task.CompletedTask; }
        public Task<LoginResult> VerifyLoginCodeAsync(string a, string c, CancellationToken ct = default) => Task.FromResult(Code!);
        public Task<LoginResult> VerifySecondFactorAsync(string c, CancellationToken ct = default) => Task.FromResult(Second!);
        public Task ChallengeSecondFactorAsync(CancellationToken ct = default) => Task.CompletedTask;
        public Task<MailboxMe> MeAsync(CancellationToken ct = default) => throw new NotImplementedException();
        public Task<List<SwitchableMailbox>> SwitchableAsync(CancellationToken ct = default) => throw new NotImplementedException();
        public Task SwitchAsync(string id, CancellationToken ct = default) => throw new NotImplementedException();
        public Task LogoutAsync(CancellationToken ct = default) => Task.CompletedTask;
    }

    private static readonly MailboxSession S = new("m", "a@b.test", null);

    [Fact]
    public async Task Password_success_signs_in_and_clears_secrets()
    {
        var vm = new SignInViewModel(new FakeAuth { Login = LoginResult.Signed(S) }) { Address = "a@b.test", Password = "pw" };
        MailboxSession? got = null;
        vm.SignedIn += s => got = s;
        await vm.SubmitPasswordAsync();
        Assert.Equal(S, got);
        Assert.Equal(SignInStep.Done, vm.Step);
        Assert.Equal("", vm.Password);
    }

    [Fact]
    public async Task Second_factor_then_code_completes()
    {
        var auth = new FakeAuth { Login = LoginResult.NeedsSecondFactor("a@b.test"), Second = LoginResult.Signed(S) };
        var vm = new SignInViewModel(auth) { Address = "a@b.test", Password = "pw" };
        await vm.SubmitPasswordAsync();
        Assert.Equal(SignInStep.SecondFactor, vm.Step);
        vm.Code = "123456";
        await vm.SubmitCodeAsync();
        Assert.Equal(SignInStep.Done, vm.Step);
    }

    [Fact]
    public async Task Emailed_code_path()
    {
        var auth = new FakeAuth { Code = LoginResult.Signed(S) };
        var vm = new SignInViewModel(auth) { Address = "a@b.test" };
        await vm.RequestCodeAsync();
        Assert.Equal(SignInStep.Code, vm.Step);
        Assert.Equal(1, auth.Codes);
        vm.Code = "123456";
        await vm.SubmitCodeAsync();
        Assert.Equal(SignInStep.Done, vm.Step);
    }

    [Fact]
    public async Task Wrong_password_shows_friendly_error_and_stays_put()
    {
        var vm = new SignInViewModel(new FakeAuth { Throw = new ApiRequestError("Invalid address or password", 401) }) { Address = "a@b.test", Password = "bad" };
        await vm.SubmitPasswordAsync();
        Assert.Equal(SignInStep.Password, vm.Step);
        Assert.Equal("Invalid address or password", vm.Error);
        Assert.False(vm.Busy);
    }

    [Fact]
    public async Task Empty_fields_do_nothing()
    {
        var vm = new SignInViewModel(new FakeAuth { Throw = new Exception("must not be called") });
        await vm.SubmitPasswordAsync();
        Assert.Null(vm.Error);
    }
}

public class MailShellViewModelTests
{
    private sealed class FakeMail : IMailApi
    {
        public string MailboxId => "m";
        public bool FailMarkRead; public bool Offline;
        public int Pages;
        public List<ApiFolder> FolderList = new() { new("Inbox", "INBOX", "\\Inbox", 2, 120), new("Sent", "Sent", "\\Sent", 0, 5) };
        public Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) => Offline ? throw new ApiTransportError("offline") : Task.FromResult(FolderList);
        public Task<ApiConversationList> ConversationsAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default)
        {
            if (Offline) throw new ApiTransportError("offline");
            Pages++;
            var items = Enumerable.Range(offset, Math.Min(limit, 120 - offset)).Select(i => OfflineCacheTests.Thread(i, unread: i == 0)).ToList();
            return Task.FromResult(new ApiConversationList(folder, 120, limit, offset, items));
        }
        public Task<ApiMailList> SearchAsync(string t, string f = "INBOX", int l = 50, int o = 0, CancellationToken ct = default) => throw new NotImplementedException();
        public Task<ApiConversationWindow> ConversationAsync(long uid, string folder, int limit = 20, long? before = null, CancellationToken ct = default) =>
            Task.FromResult(new ApiConversationWindow(new() { new ApiMailDetail(uid, folder, 1, "S", "Ada", "ada@example.test", null, null, "2026-01-01T10:00:00Z", false, false, false, "<m>", null, null, "hi", null, null) }, 1, 1, false, 0));
        public Task<ApiMarkReadResult> MarkThreadReadAsync(long uid, string folder, CancellationToken ct = default) =>
            FailMarkRead ? throw new ApiRequestError("nope", 500) : Task.FromResult(new ApiMarkReadResult(1, true));
        public Task SetFlagsAsync(long uid, string folder, bool? seen = null, bool? flagged = null, CancellationToken ct = default) => Task.CompletedTask;
        public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> emails, CancellationToken ct = default) =>
            Task.FromResult(new AvatarBatchResponse(new()));
    }

    [Fact]
    public async Task Start_loads_inbox_and_first_page()
    {
        var vm = new MailShellViewModel(new FakeMail(), "https://mail.example.test");
        await vm.StartAsync();
        Assert.Equal("INBOX", vm.SelectedFolder!.Path);
        Assert.Equal(50, vm.Threads.Count);
        Assert.True(vm.HasMore);
        Assert.Equal(2, vm.TotalUnread);
    }

    [Fact]
    public async Task Load_more_appends_without_duplicates_until_exhausted()
    {
        var vm = new MailShellViewModel(new FakeMail(), "https://mail.example.test");
        await vm.StartAsync();
        await vm.LoadMoreAsync(); await vm.LoadMoreAsync(); await vm.LoadMoreAsync();
        Assert.Equal(120, vm.Threads.Count);
        Assert.Equal(120, vm.Threads.Select(t => t.ThreadKey).Distinct().Count());
        Assert.False(vm.HasMore);
    }

    [Fact]
    public async Task Open_marks_read_optimistically_and_decrements_unread()
    {
        var vm = new MailShellViewModel(new FakeMail(), "https://mail.example.test");
        await vm.StartAsync();
        var row = vm.Threads[0];
        Assert.True(row.Unread);
        await vm.OpenAsync(row);
        Assert.False(row.Unread);
        Assert.Equal(1, vm.TotalUnread);
        Assert.Single(vm.OpenMessages);
        Assert.True(vm.OpenMessages[0].Expanded);
    }

    [Fact]
    public async Task Failed_mark_read_rolls_back()
    {
        var vm = new MailShellViewModel(new FakeMail { FailMarkRead = true }, "https://mail.example.test");
        await vm.StartAsync();
        var row = vm.Threads[0];
        await vm.OpenAsync(row);
        Assert.True(row.Unread);
        Assert.Equal(2, vm.TotalUnread);
        Assert.NotNull(vm.OpenError);
    }

    [Fact]
    public async Task Offline_start_paints_cache_and_flags_offline()
    {
        using var cache = new Core.Cache.OfflineCache(":memory:");
        var mail = new FakeMail();
        await new MailShellViewModel(mail, "https://mail.example.test", cache).StartAsync();
        mail.Offline = true;
        var vm = new MailShellViewModel(mail, "https://mail.example.test", cache);
        await vm.StartAsync();
        Assert.True(vm.Offline);
        Assert.Equal(50, vm.Threads.Count);
        Assert.Equal(2, vm.Folders.Count);
    }

    [Fact]
    public async Task Sent_folder_rows_use_open_avatar_trust()
    {
        var vm = new MailShellViewModel(new FakeMail(), "https://mail.example.test");
        await vm.StartAsync();
        await vm.LoadFolderAsync(vm.Folders.First(f => f.Path == "Sent"));
        Assert.All(vm.Threads, r => Assert.Equal("me@example.test", r.AvatarAddress));
    }
}

public class SearchAndCardTests
{
    private sealed class SearchMail : IMailApi
    {
        public string MailboxId => "m";
        public List<string> Queries = new();
        public Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) => Task.FromResult(new List<ApiFolder> { new("Inbox", "INBOX", "\\Inbox", 0, 5) });
        public Task<ApiConversationList> ConversationsAsync(string f, int l = 50, int o = 0, CancellationToken ct = default) =>
            Task.FromResult(new ApiConversationList(f, 1, l, o, new() { OfflineCacheTests.Thread(1) }));
        public Task<ApiMailList> SearchAsync(string t, string f = "INBOX", int l = 50, int o = 0, CancellationToken ct = default)
        {
            Queries.Add(t);
            var hit = new ApiMailSummary(9, f, "<9@x>", "Budget", "Ada", "ada@example.test", null, "2026-01-01T10:00:00Z", false, false, false, true, "numbers");
            return Task.FromResult(new ApiMailList(f, 1, l, o, new() { hit }));
        }
        public Task<ApiConversationWindow> ConversationAsync(long u, string f, int l = 20, long? b = null, CancellationToken ct = default) => throw new NotImplementedException();
        public Task<ApiMarkReadResult> MarkThreadReadAsync(long u, string f, CancellationToken ct = default) => throw new NotImplementedException();
        public Task SetFlagsAsync(long u, string f, bool? s = null, bool? fl = null, CancellationToken ct = default) => Task.CompletedTask;
        public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> e, CancellationToken ct = default) => Task.FromResult(new AvatarBatchResponse(new()));
    }

    [Fact]
    public async Task Search_shows_results_as_rows_and_empty_query_restores_the_folder()
    {
        var mail = new SearchMail();
        var vm = new MailShellViewModel(mail, "https://mail.example.test");
        await vm.StartAsync();
        await vm.SearchAsync("budget");
        Assert.True(vm.Searching);
        Assert.Equal("Budget", vm.Threads.Single().Subject);
        Assert.True(vm.Threads.Single().Unread);
        await vm.SearchAsync("");
        Assert.False(vm.Searching);
        Assert.Equal("t1", vm.Threads.Single().ThreadKey);
    }

    [Fact]
    public void Remote_content_is_detected_only_for_network_loads()
    {
        MessageCardVm Card(string html) => new(new ApiMailDetail(1, "INBOX", 1, "s", "A", "a@x.test", null, null, "2026-01-01T10:00:00Z", true, false, false, "<1>", null, null, null, html, null), "me@x.test", true);
        Assert.True(Card("<img src=\"https://t.example/p.gif\">").HasRemoteContent);
        Assert.True(Card("<div style=\"background:url('http://t.example/b.png')\"></div>").HasRemoteContent);
        Assert.False(Card("<img src=\"data:image/png;base64,AAAA\"><p>hi</p>").HasRemoteContent);
        Assert.False(Card("<p>no pictures</p>").HasRemoteContent);
    }
}
