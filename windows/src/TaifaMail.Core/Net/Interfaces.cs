using TaifaMail.Core.Models;

namespace TaifaMail.Core.Net;

public interface IAuthApi
{
    Task<LoginResult> LoginAsync(string address, string password, CancellationToken ct = default);
    Task RequestLoginCodeAsync(string address, CancellationToken ct = default);
    Task<LoginResult> VerifyLoginCodeAsync(string address, string code, CancellationToken ct = default);
    Task<LoginResult> VerifySecondFactorAsync(string code, CancellationToken ct = default);
    Task ChallengeSecondFactorAsync(CancellationToken ct = default);
    Task<MailboxMe> MeAsync(CancellationToken ct = default);
    Task<List<SwitchableMailbox>> SwitchableAsync(CancellationToken ct = default);
    Task SwitchAsync(string mailboxId, CancellationToken ct = default);
    Task LogoutAsync(CancellationToken ct = default);
}

public interface IMailApi
{
    string MailboxId { get; }
    Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default);
    Task<ApiConversationList> ConversationsAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default);
    Task<ApiMailList> SearchAsync(string text, string folder = "INBOX", int limit = 50, int offset = 0, CancellationToken ct = default);
    Task<ApiConversationWindow> ConversationAsync(long uid, string folder, int limit = 20, long? before = null, CancellationToken ct = default);
    Task<ApiMarkReadResult> MarkThreadReadAsync(long uid, string folder, CancellationToken ct = default);
    Task SetFlagsAsync(long uid, string folder, bool? seen = null, bool? flagged = null, CancellationToken ct = default);
    Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> emails, CancellationToken ct = default);

    // Members below have default bodies so read-only fakes stay small.
    Task<ApiQuota?> QuotaAsync(CancellationToken ct = default) => Task.FromResult<ApiQuota?>(null);
    Task<ApiBatchResult> BatchFlagsAsync(string folder, IReadOnlyCollection<long> uids, bool? seen = null, bool? flagged = null, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchMoveAsync(string folder, IReadOnlyCollection<long> uids, string toFolder, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchArchiveAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchDeleteAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchSpamAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchNotSpamAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiBatchResult> BatchPermanentAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiMailList> MessagesAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiResolved> ResolveAsync(string messageId, string folder, CancellationToken ct = default) => throw new NotSupportedException();
    Task<ApiConversationWindow> OlderAsync(long uid, string folder, long before, CancellationToken ct = default) => throw new NotSupportedException();
}
