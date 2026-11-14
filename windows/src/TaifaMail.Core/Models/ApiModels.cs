using System.Text.Json.Serialization;

namespace TaifaMail.Core.Models;

// Wire models for the Taifa Mail API. Property names map to snake_case through
// TaifaJson.Options, so only names that differ need an attribute.

public sealed record MailboxSession(string MailboxId, string Address, string? OrgId);

public sealed record MailboxMe(string MailboxId, string Address, string? OrgId, string? DisplayName, string? Classification, string? AvatarUrl);

public sealed record SwitchableMailbox(string MailboxId, string Address, string? DisplayName, string? AvatarUrl, string? Access);

public sealed record ApiFolder(string Name, string Path, string? SpecialUse, int Unseen, int Total);

public sealed record ApiFolderCount(string Path, int Unseen, int Total);

public sealed record ApiMailSummary(
    long Uid,
    string Folder,
    string MessageId,
    string Subject,
    string FromName,
    string FromAddr,
    List<string>? To,
    string Date,
    bool Seen,
    bool Flagged,
    bool Answered,
    bool HasAttachments,
    string Snippet,
    string? AuthLevel = null,
    bool? SenderVerified = null,
    bool AuthWarned = false);

public sealed record ApiMailList(string Folder, int Total, int Limit, int Offset, List<ApiMailSummary> Items);

public sealed record ApiConversationSummary(string ThreadKey, ApiMailSummary Latest, int Count, bool Unread, List<long>? Uids);

public sealed record ApiConversationList(string Folder, int Total, int Limit, int Offset, List<ApiConversationSummary> Items);

public sealed record ApiAttachment(string PartId, string Filename, string ContentType, long Size);

public sealed record ApiMailDetail(
    long Uid,
    string Folder,
    long? SourceUidvalidity,
    string Subject,
    string FromName,
    string FromAddr,
    List<string>? To,
    List<string>? Cc,
    string Date,
    bool Seen,
    bool Flagged,
    bool Answered,
    string MessageId,
    string? ReplyTo,
    string? References,
    string? Text,
    string? Html,
    List<ApiAttachment>? Attachments,
    ApiAuthWarning? AuthWarning = null,
    bool? SenderVerified = null,
    List<string>? Bcc = null,
    List<string>? FileIds = null);

public sealed record ApiAuthWarning(string Level, string? Code, string? Title, string? Message, bool LinksDisabled);

public sealed record ApiConversationWindow(List<ApiMailDetail> Messages, long? SourceUidvalidity, int Total, bool HasMoreOlder, long NextBefore);

public sealed record ApiBatchFailure(long Uid, string Reason);

public sealed record ApiBatchResult(bool Ok, int Requested, List<long>? Succeeded, List<ApiBatchFailure>? Failed);

public sealed record ApiMarkReadResult(int Marked, bool Complete = true);

public sealed record ApiOk(bool Ok);

public sealed record SendMailPayload
{
    public List<string> To { get; init; } = new();
    public List<string>? Cc { get; init; }
    public List<string>? Bcc { get; init; }
    public string Subject { get; init; } = "";
    public string? Text { get; init; }
    public string? Html { get; init; }
    public string? InReplyTo { get; init; }
    public string? References { get; init; }
    public long? ReplyUid { get; init; }
    public string? ReplyFolder { get; init; }
    public List<string>? FileIds { get; init; }
    public long? ReplaceUid { get; init; }
    public string? OpId { get; init; }
}

public sealed record ApiSendResult(bool Ok, string MessageId, List<string>? Suppressed, List<string>? Refused);

public sealed record ApiDraftResult(long Uid, string Folder);

public sealed record AvatarBatchEntry(string? Url, string? Name, string? UrlScope, AvatarInstitution? Institution);

public sealed record AvatarInstitution(string? Name, string? LogoUrl);

public sealed record AvatarBatchResponse(Dictionary<string, AvatarBatchEntry> Results);

public sealed record ApiAutoResponder(
    bool Enabled, string Subject, string Html, string Text, string Mode,
    string? StartAt, string? EndAt, List<int> Days, int StartHour, int EndHour);

public sealed record ApiMailBlock(string Id, string BlockType, string Name, string Html, string? Text, bool IsDefault);

public sealed record ApiMailboxBlocks(List<ApiMailBlock> Signatures, List<ApiMailBlock> Headers, List<ApiMailBlock> Footers);

public sealed record ApiMailboxSettings(string Id, string? DisplayName, string Address, string Theme, string Locale, string Timezone, List<string>? TrustedImageSenders);

/// <summary>Result of the password or sign-in-code step.</summary>
public sealed record LoginResult(MailboxSession? Session, bool RequiresSecondFactor, string? Address)
{
    public static LoginResult Signed(MailboxSession s) => new(s, false, s.Address);
    public static LoginResult NeedsSecondFactor(string address) => new(null, true, address);
}

internal sealed record RawLogin(string? MailboxId, string? Address, string? OrgId, [property: JsonPropertyName("requires_2fa")] bool? Requires2Fa);
