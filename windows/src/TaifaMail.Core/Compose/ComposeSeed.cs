using System.Text.RegularExpressions;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Compose;

public enum ComposeMode { New, Reply, ReplyAll, Forward }

public sealed record ComposeSeed(
    ComposeMode Mode,
    IReadOnlyList<string> To,
    IReadOnlyList<string> Cc,
    string Subject,
    string? InReplyTo = null,
    string? References = null,
    long? ReplyUid = null,
    string? ReplyFolder = null,
    string? QuotedHtml = null,
    string? QuotedText = null,
    string? QuoteHeader = null,
    IReadOnlyList<ApiAttachment>? ForwardAttachments = null,
    long? ForwardUid = null,
    string? ForwardFolder = null);

/// <summary>Prefills Reply, Reply all and Forward (spec section 8.7).</summary>
public static class ComposeSeeds
{
    public static ComposeSeed Blank() => new(ComposeMode.New, Array.Empty<string>(), Array.Empty<string>(), "");

    public static ComposeSeed For(ComposeMode mode, ApiMailDetail m, string ownAddress)
    {
        if (mode == ComposeMode.New) return Blank();
        var own = AvatarRule.NormalizeAddress(ownAddress);
        var header = $"On {FormatDate(m.Date)}, {(string.IsNullOrWhiteSpace(m.FromName) ? m.FromAddr : $"{m.FromName} <{m.FromAddr}>")} wrote:";
        var refs = string.Join(' ', new[] { m.References, m.MessageId }.Where(x => !string.IsNullOrWhiteSpace(x))).Trim();
        if (mode == ComposeMode.Forward)
        {
            var fwdHeader = $"---------- Forwarded message ----------\nFrom: {m.FromName} <{m.FromAddr}>\nDate: {FormatDate(m.Date)}\nSubject: {m.Subject}\nTo: {string.Join(", ", m.To ?? new())}";
            return new ComposeSeed(mode, Array.Empty<string>(), Array.Empty<string>(), Prefix("Fwd: ", m.Subject), null, null, null, null, m.Html, m.Text, fwdHeader, m.Attachments, m.Uid, m.Folder);
        }
        var sender = AvatarRule.NormalizeAddress(m.FromAddr) == own && (m.To?.Count ?? 0) > 0 ? m.To!.ToList() : new List<string> { string.IsNullOrWhiteSpace(m.ReplyTo) ? m.FromAddr : m.ReplyTo! };
        var cc = new List<string>();
        if (mode == ComposeMode.ReplyAll)
        {
            var seen = new HashSet<string>(sender.Select(AvatarRule.NormalizeAddress)) { own };
            foreach (var a in (m.To ?? new()).Concat(m.Cc ?? new()))
            {
                var n = AvatarRule.NormalizeAddress(a);
                if (n.Length > 0 && seen.Add(n)) cc.Add(a);
            }
        }
        return new ComposeSeed(mode, sender, cc, Prefix("Re: ", m.Subject), m.MessageId, refs.Length > 0 ? refs : null, m.Uid, m.Folder, m.Html, m.Text, header);
    }

    private static string Prefix(string prefix, string subject) =>
        Regex.IsMatch(subject ?? "", "^\\s*" + Regex.Escape(prefix.Trim()), RegexOptions.IgnoreCase) ? subject! : prefix + subject;

    private static string FormatDate(string iso) => DateTimeOffset.TryParse(iso, out var d) ? d.ToLocalTime().ToString("ddd, d MMM yyyy 'at' HH:mm") : iso;
}
