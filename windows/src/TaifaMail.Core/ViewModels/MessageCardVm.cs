using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.ViewModels;

/// <summary>One message in the open conversation: header facts, expand state and the per message remote image choice.</summary>
public sealed partial class MessageCardVm : ObservableObject
{
    public MessageCardVm(ApiMailDetail detail, string ownAddress, bool isLatest)
    {
        Detail = detail;
        OwnAddress = ownAddress;
        _expanded = isLatest;
        var (address, name) = AvatarRule.Subject(detail.FromAddr, detail.FromName, null, false);
        AvatarAddress = address;
        DisplayName = name.Length > 0 ? name : address;
        (Initials, PlaceholderColor) = AvatarRule.Placeholder(address, name);
        Auth = new MessageAuth(detail.AuthWarning is not null ? (detail.AuthWarning.Level ?? "info") : null, detail.SenderVerified, AuthWarned: detail.AuthWarning is not null);
    }

    public ApiMailDetail Detail { get; }
    public string OwnAddress { get; }
    public string AvatarAddress { get; }
    public string DisplayName { get; }
    public string Initials { get; }
    public string PlaceholderColor { get; }
    public MessageAuth Auth { get; }

    [ObservableProperty] private bool _expanded;
    [ObservableProperty, NotifyPropertyChangedFor(nameof(ShowImagesPrompt))] private bool _allowImages;
    [ObservableProperty] private AvatarDecision? _avatar;

    public string Subject => Detail.Subject.Length > 0 ? Detail.Subject : "(no subject)";
    public bool HasHtml => !string.IsNullOrWhiteSpace(Detail.Html);
    public string PlainText => Detail.Text ?? "";
    public IReadOnlyList<ApiAttachment> Attachments => Detail.Attachments ?? new List<ApiAttachment>();
    public bool HasAttachments => Attachments.Count > 0;
    public bool Flagged => Detail.Flagged;

    /// <summary>True when the HTML asks for pictures or styles from the network, so the "Show images" prompt is worth showing.</summary>
    public bool HasRemoteContent => HasHtml && System.Text.RegularExpressions.Regex.IsMatch(Detail.Html!,
        "(?:src|background|srcset)\\s*=\\s*[\"']?\\s*https?:|url\\(\\s*[\"']?https?:", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    public bool ShowImagesPrompt => HasRemoteContent && !AllowImages;
    public string FirstLine
    {
        get
        {
            var t = System.Text.RegularExpressions.Regex.Replace(Detail.Text ?? "", @"\s+", " ").Trim();
            return t.Length > 140 ? t[..140] : t;
        }
    }

    public string ToLine => ToLineFor(Detail.To, Detail.Cc, OwnAddress);

    /// <summary>"to me, +2": the viewer's own address collapses to "me", the rest to a count.</summary>
    public static string ToLineFor(IReadOnlyList<string>? to, IReadOnlyList<string>? cc, string own)
    {
        var all = (to ?? new List<string>()).Concat(cc ?? new List<string>()).Where(a => AvatarRule.NormalizeAddress(a).Length > 0).ToList();
        if (all.Count == 0) return "to undisclosed recipients";
        var mine = all.FindIndex(a => AvatarRule.NormalizeAddress(a) == AvatarRule.NormalizeAddress(own));
        string First(string a) { var m = System.Text.RegularExpressions.Regex.Match(a, "^\\s*\"?([^\"<]+?)\"?\\s*<"); return m.Success ? m.Groups[1].Value.Trim() : AvatarRule.NormalizeAddress(a); }
        var lead = mine >= 0 ? "me" : First(all[0]);
        var rest = all.Count - 1;
        return rest > 0 ? $"to {lead}, +{rest}" : $"to {lead}";
    }

    public DateTimeOffset When => DateTimeOffset.TryParse(Detail.Date, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : DateTimeOffset.MinValue;

    /// <summary>"none", "info", "warning" or "danger" from the server's auth_warning.level.</summary>
    public string AuthLevel => Detail.AuthWarning?.Level ?? "none";
    public bool HasAuthBanner => Detail.AuthWarning is not null;
    public bool LinksDisabled => Detail.AuthWarning?.LinksDisabled == true;

    public static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        _ => $"{bytes / 1024.0 / 1024.0:0.#} MB",
    };
}
