using System.Text;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Net;

/// <summary>Typed, mailbox scoped calls against /v1/inbox/{id}. Only endpoints the shipped app uses.</summary>
public sealed class MailApi : IMailApi
{
    private readonly TaifaApiClient _api;
    public string MailboxId { get; }

    public MailApi(TaifaApiClient api, string mailboxId)
    {
        _api = api;
        MailboxId = mailboxId;
    }

    private string P(string suffix) => $"/v1/inbox/{Uri.EscapeDataString(MailboxId)}{suffix}";

    public static string Q(params (string Key, object? Value)[] pairs)
    {
        var sb = new StringBuilder();
        foreach (var (k, v) in pairs)
        {
            if (v is null) continue;
            var text = v is bool b ? (b ? "true" : "false") : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "";
            sb.Append(sb.Length == 0 ? '?' : '&').Append(Uri.EscapeDataString(k)).Append('=').Append(Uri.EscapeDataString(text));
        }
        return sb.ToString();
    }

    public Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) => _api.GetAsync<List<ApiFolder>>(P("/folders" + Q(("with_counts", true))), ct);
    public Task<List<ApiFolderCount>> FolderCountsAsync(CancellationToken ct = default) => _api.GetAsync<List<ApiFolderCount>>(P("/folder-counts"), ct);

    public Task<ApiConversationList> ConversationsAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default) =>
        _api.GetAsync<ApiConversationList>(P("/conversations" + Q(("folder", folder), ("limit", limit), ("offset", offset))), ct);

    public Task<ApiMailList> MessagesAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default) =>
        _api.GetAsync<ApiMailList>(P("/messages" + Q(("folder", folder), ("limit", limit), ("offset", offset))), ct);

    public Task<ApiMailList> SearchAsync(string text, string folder = "INBOX", int limit = 50, int offset = 0, CancellationToken ct = default) =>
        _api.GetAsync<ApiMailList>(P("/search" + Q(("q", text), ("folder", folder), ("limit", limit), ("offset", offset))), ct);

    /// <summary>The conversation containing <paramref name="uid"/>. mark_seen is false: reads are marked explicitly so they can roll back.</summary>
    public Task<ApiConversationWindow> ConversationAsync(long uid, string folder, int limit = 20, long? before = null, CancellationToken ct = default) =>
        _api.GetAsync<ApiConversationWindow>(P("/conversation" + Q(("uid", uid), ("folder", folder), ("limit", limit), ("before", before), ("mark_seen", false), ("bodies", "all"))), ct);

    public Task<ApiMailDetail> MessageAsync(long uid, string folder, CancellationToken ct = default) =>
        _api.GetAsync<ApiMailDetail>(P($"/messages/{uid}" + Q(("folder", folder))), ct);

    public Task<ApiMarkReadResult> MarkThreadReadAsync(long uid, string folder, CancellationToken ct = default) =>
        _api.PostAsync<ApiMarkReadResult>(P($"/conversation/{uid}/mark-read" + Q(("folder", folder))), null, ct);

    public Task SetFlagsAsync(long uid, string folder, bool? seen = null, bool? flagged = null, CancellationToken ct = default) =>
        _api.PostAsync(P($"/messages/{uid}/flags" + Q(("folder", folder))), new { seen, flagged }, ct);

    public Task MoveAsync(long uid, string folder, string toFolder, CancellationToken ct = default) =>
        _api.PostAsync(P($"/messages/{uid}/move" + Q(("folder", folder))), new { to_folder = toFolder }, ct);

    public Task ArchiveAsync(long uid, string folder, CancellationToken ct = default) =>
        _api.PostAsync(P($"/messages/{uid}/archive" + Q(("folder", folder))), null, ct);

    public Task DeleteAsync(long uid, string folder, bool permanent = false, CancellationToken ct = default) =>
        _api.DeleteAsync(P($"/messages/{uid}" + (permanent ? "/permanent" : "") + Q(("folder", folder))), ct);

    public Task<ApiBatchResult> BatchFlagsAsync(string folder, IReadOnlyCollection<long> uids, bool? seen = null, bool? flagged = null, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/flags" + Q(("folder", folder))), new { uids, seen, flagged }, ct);

    public Task<ApiBatchResult> BatchMoveAsync(string folder, IReadOnlyCollection<long> uids, string toFolder, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/move" + Q(("folder", folder))), new { uids, to_folder = toFolder }, ct);

    public Task<ApiBatchResult> BatchArchiveAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/archive" + Q(("folder", folder))), new { uids }, ct);

    public Task<ApiBatchResult> BatchDeleteAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/delete" + Q(("folder", folder))), new { uids }, ct);

    public Task<ApiQuota?> QuotaAsync(CancellationToken ct = default) => _api.GetAsync<ApiQuota?>(P("/quota"), ct);

    public Task<ApiBatchResult> BatchSpamAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/spam" + Q(("folder", folder))), new { uids }, ct);

    public Task<ApiResolved> ResolveAsync(string messageId, string folder, CancellationToken ct = default) =>
        _api.GetAsync<ApiResolved>(P("/messages/resolve" + Q(("message_id", messageId), ("folder", folder))), ct);

    public Task<ApiConversationWindow> OlderAsync(long uid, string folder, long before, CancellationToken ct = default) =>
        ConversationAsync(uid, folder, 20, before, ct);

    /// <summary>The contacts endpoint answers a bare JSON array (contacts_book.py), not an envelope.</summary>
    public Task<List<ApiContact>> ContactsAsync(string q, int limit = 8, CancellationToken ct = default) =>
        _api.GetAsync<List<ApiContact>>("/v1/mailbox/contacts/" + Q(("q", q), ("limit", limit)), ct);

    public Task<ApiFileEnvelope> FileStatusAsync(string fileId, CancellationToken ct = default) =>
        _api.GetAsync<ApiFileEnvelope>($"/v1/files/{Uri.EscapeDataString(fileId)}", ct);

    public Task<ApiImageCapability> ImageProxyCapabilityAsync(CancellationToken ct = default) =>
        _api.GetAsync<ApiImageCapability>(P("/image-proxy-capability"), ct);

    public Task<ApiBatchResult> BatchNotSpamAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/not-spam" + Q(("folder", folder))), new { uids }, ct);

    public Task<ApiBatchResult> BatchPermanentAsync(string folder, IReadOnlyCollection<long> uids, CancellationToken ct = default) =>
        _api.PostAsync<ApiBatchResult>(P("/messages/batch/permanent" + Q(("folder", folder))), new { uids }, ct);

    public Task<ApiFileTicket> CreateUploadAsync(string filename, string mime, long size, CancellationToken ct = default) =>
        _api.PostAsync<ApiFileTicket>("/v1/files/", new { filename, mime, size, access = "link", mailbox_id = MailboxId, expires_in_days = (int?)null }, ct);

    public Task<ApiFileEnvelope> CompleteUploadAsync(string fileId, CancellationToken ct = default) =>
        _api.PostAsync<ApiFileEnvelope>($"/v1/files/{Uri.EscapeDataString(fileId)}/complete", null, ct);

    public Task DeleteUploadAsync(string fileId, CancellationToken ct = default) => _api.DeleteAsync($"/v1/files/{Uri.EscapeDataString(fileId)}", ct);

    public Task<ApiStaged> StageAttachmentsAsync(long uid, string folder, CancellationToken ct = default) =>
        _api.PostAsync<ApiStaged>(P($"/messages/{uid}/stage-attachments" + Q(("folder", folder))), null, ct);

    public Task UploadBytesAsync(ApiUploadTarget target, Stream content, CancellationToken ct = default) => _api.PutPresignedAsync(target, content, ct);

    public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> emails, CancellationToken ct = default) =>
        _api.PostAsync<AvatarBatchResponse>(P("/avatars/batch"), new { emails }, ct);

    public string AttachmentPath(long uid, string partId, string folder, bool inline = false) =>
        P($"/attachments/{uid}/{Uri.EscapeDataString(partId)}" + Q(("folder", folder), ("inline", inline)));

    public Task DownloadAttachmentAsync(long uid, string partId, string folder, Stream destination, CancellationToken ct = default) =>
        _api.DownloadAsync(AttachmentPath(uid, partId, folder), destination, ct);

    public Task<ApiSendResult> SendAsync(SendMailPayload payload, CancellationToken ct = default) =>
        _api.PostAsync<ApiSendResult>(P("/send"), payload, ct);

    public Task<ApiDraftResult> SaveDraftAsync(SendMailPayload payload, CancellationToken ct = default) =>
        _api.PostAsync<ApiDraftResult>(P("/drafts"), payload, ct);
}

/// <summary>Mailbox level settings the first version surfaces (signature, auto reply).</summary>
public sealed class SettingsApi
{
    private readonly TaifaApiClient _api;
    public SettingsApi(TaifaApiClient api) => _api = api;

    public Task<ApiMailboxSettings> GetAsync(CancellationToken ct = default) => _api.GetAsync<ApiMailboxSettings>("/v1/mailbox/settings", ct);
    public Task<ApiAutoResponder> AutoResponderAsync(CancellationToken ct = default) => _api.GetAsync<ApiAutoResponder>("/v1/mailbox/autoresponder", ct);
    public Task<ApiAutoResponder> SetAutoResponderAsync(ApiAutoResponder config, CancellationToken ct = default) => _api.PutAsync<ApiAutoResponder>("/v1/mailbox/autoresponder", config, ct);
    public Task<ApiMailboxBlocks> BlocksAsync(CancellationToken ct = default) => _api.GetAsync<ApiMailboxBlocks>("/v1/mailbox/blocks", ct);
    public Task<ApiMailBlock> CreateSignatureAsync(string name, string html, string text, CancellationToken ct = default) =>
        _api.PostAsync<ApiMailBlock>("/v1/mailbox/blocks", new { block_type = "signature", name, html, text, is_default = true }, ct);
    public Task<ApiMailBlock> UpdateBlockAsync(string id, string html, string text, CancellationToken ct = default) =>
        _api.SendJsonAsync(HttpMethod.Patch, $"/v1/mailbox/blocks/{Uri.EscapeDataString(id)}", new { html, text }, ct)
            .ContinueWith(t => System.Text.Json.JsonSerializer.Deserialize<ApiMailBlock>(t.Result, TaifaJson.Options)!, ct);
    public Task<ApiMailboxSettings> AddTrustedImageSenderAsync(string email, CancellationToken ct = default) =>
        _api.PostAsync<ApiMailboxSettings>("/v1/mailbox/settings/trusted-senders", new { email }, ct);
}
