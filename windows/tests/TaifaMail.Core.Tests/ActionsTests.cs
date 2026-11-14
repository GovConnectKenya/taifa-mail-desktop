using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;

namespace TaifaMail.Core.Tests;

public class ActionsTests
{
    private sealed class ActMail : IMailApi
    {
        public string MailboxId => "m";
        public bool Fail;
        public List<string> Calls = new();
        public Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) => Task.FromResult(new List<ApiFolder> { new("Inbox", "INBOX", "\\Inbox", 2, 5), new("Archive", "Archive", "\\Archive", 0, 0), new("Trash", "Trash", "\\Trash", 0, 0) });
        public Task<ApiConversationList> ConversationsAsync(string f, int l = 50, int o = 0, CancellationToken ct = default) =>
            Task.FromResult(new ApiConversationList(f, 3, l, o, Enumerable.Range(1, 3).Select(i => OfflineCacheTests.Thread(i, unread: i <= 2)).ToList()));
        public Task<ApiMailList> SearchAsync(string t, string f = "INBOX", int l = 50, int o = 0, CancellationToken ct = default) => throw new NotImplementedException();
        public Task<ApiConversationWindow> ConversationAsync(long u, string f, int l = 20, long? b = null, CancellationToken ct = default) => throw new NotImplementedException();
        public Task<ApiMarkReadResult> MarkThreadReadAsync(long u, string f, CancellationToken ct = default) => throw new NotImplementedException();
        public Task SetFlagsAsync(long u, string f, bool? s = null, bool? fl = null, CancellationToken ct = default) => Task.CompletedTask;
        public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> e, CancellationToken ct = default) => Task.FromResult(new AvatarBatchResponse(new()));
        private Task<ApiBatchResult> Do(string name, IReadOnlyCollection<long> uids)
        {
            Calls.Add($"{name}:{string.Join(',', uids)}");
            return Fail ? throw new ApiRequestError("no", 500) : Task.FromResult(new ApiBatchResult(true, uids.Count, uids.ToList(), null));
        }
        public Task<ApiBatchResult> BatchArchiveAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("archive", u);
        public Task<ApiBatchResult> BatchDeleteAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("delete", u);
        public Task<ApiBatchResult> BatchSpamAsync(string f, IReadOnlyCollection<long> u, CancellationToken ct = default) => Do("spam", u);
        public Task<ApiBatchResult> BatchMoveAsync(string f, IReadOnlyCollection<long> u, string to, CancellationToken ct = default) => Do("move->" + to, u);
        public Task<ApiBatchResult> BatchFlagsAsync(string f, IReadOnlyCollection<long> u, bool? seen = null, bool? flagged = null, CancellationToken ct = default) => Do($"flags seen={seen} flagged={flagged}", u);
        public Task<ApiResolved> ResolveAsync(string id, string folder, CancellationToken ct = default) => Task.FromResult(new ApiResolved(folder, 900));
    }

    private static async Task<(MailShellViewModel Vm, ActMail Api)> Started(bool fail = false)
    {
        var api = new ActMail { Fail = fail };
        var vm = new MailShellViewModel(api, "https://mail.example.test");
        await vm.StartAsync();
        return (vm, api);
    }

    [Fact] public async Task Archive_removes_the_row_calls_the_api_and_offers_undo()
    {
        var (vm, api) = await Started();
        string? msg = null; Func<Task>? undo = null;
        vm.Notice += (m, u) => { msg = m; undo = u; };
        await vm.ArchiveAsync(new[] { vm.Threads[0] });
        Assert.Equal(2, vm.Threads.Count);
        Assert.Equal("archive:1", api.Calls.Single());
        Assert.Equal("Archived", msg);
        Assert.NotNull(undo);
        Assert.Equal(1, vm.TotalUnread);
        await undo!();
        Assert.Contains("move->INBOX:900", api.Calls);
    }

    [Fact] public async Task Failed_delete_restores_rows_and_counts()
    {
        var (vm, _) = await Started(fail: true);
        string? msg = null;
        vm.Notice += (m, _) => msg = m;
        var first = vm.Threads[0];
        await vm.DeleteAsync(new[] { first });
        Assert.Same(first, vm.Threads[0]);
        Assert.Equal(3, vm.Threads.Count);
        Assert.Equal(2, vm.TotalUnread);
        Assert.Contains("Nothing was changed", msg);
    }

    [Fact] public async Task Mark_unread_and_star_apply_optimistically_and_roll_back()
    {
        var (vm, _) = await Started();
        var row = vm.Threads[2];
        await vm.SetReadAsync(new[] { row }, read: false);
        Assert.True(row.Unread);
        Assert.Equal(3, vm.TotalUnread);
        await vm.ToggleFlagAsync(new[] { row });
        Assert.True(row.Flagged);

        var (vm2, _) = await Started(fail: true);
        var r2 = vm2.Threads[2];
        await vm2.SetReadAsync(new[] { r2 }, read: false);
        Assert.False(r2.Unread);
        Assert.Equal(2, vm2.TotalUnread);
    }

    [Fact] public async Task Offline_blocks_changes_with_the_tooltip_text()
    {
        var (vm, api) = await Started();
        vm.Offline = true;
        string? msg = null;
        vm.Notice += (m, _) => msg = m;
        await vm.ArchiveAsync(new[] { vm.Threads[0] });
        Assert.Equal("Not available offline", msg);
        Assert.Empty(api.Calls);
    }
}
