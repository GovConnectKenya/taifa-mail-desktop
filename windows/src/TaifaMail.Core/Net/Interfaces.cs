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
}
