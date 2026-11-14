using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.ViewModels;

/// <summary>One row of the thread list. Mutable bits raise change notifications so an optimistic update repaints only that row.</summary>
public sealed partial class ThreadRow : ObservableObject
{
    public ThreadRow(ApiConversationSummary model, bool outgoing)
    {
        Model = model;
        var (address, name) = AvatarRule.Subject(model.Latest.FromAddr, model.Latest.FromName, model.Latest.To, outgoing);
        AvatarAddress = address;
        DisplayName = name.Length > 0 ? name : address;
        _unread = model.Unread;
        _flagged = model.Latest.Flagged;
        Auth = new MessageAuth(model.Latest.AuthLevel, model.Latest.SenderVerified, model.Latest.AuthWarned);
        (Initials, PlaceholderColor) = AvatarRule.Placeholder(address, name);
    }

    public ApiConversationSummary Model { get; }
    public string AvatarAddress { get; }
    public string DisplayName { get; }
    public string Initials { get; }
    public string PlaceholderColor { get; }
    public MessageAuth Auth { get; }
    public string Subject => Model.Latest.Subject.Length > 0 ? Model.Latest.Subject : "(no subject)";
    public string Snippet => Model.Latest.Snippet;
    public bool HasAttachment => Model.Latest.HasAttachments;
    public int Count => Model.Count;
    public long Uid => Model.Latest.Uid;
    public string Folder => Model.Latest.Folder;
    public string ThreadKey => Model.ThreadKey;
    public IReadOnlyList<long> Uids => Model.Uids is { Count: > 0 } u ? u : new[] { Model.Latest.Uid };

    [ObservableProperty] private bool _compact;
    [ObservableProperty] private bool _unread;
    [ObservableProperty] private bool _flagged;
    [ObservableProperty] private AvatarDecision? _avatar;

    /// <summary>What a screen reader says for the row (spec section 14).</summary>
    public string SpokenName =>
        $"{DisplayName}, {Subject}, {TimeLabel.ForList(When, DateTimeOffset.Now)}, {(Unread ? "unread" : "read")}{(Flagged ? ", flagged" : "")}{(HasAttachment ? ", has attachments" : "")}";

    public DateTimeOffset When => DateTimeOffset.TryParse(Model.Latest.Date, out var d) ? d : DateTimeOffset.MinValue;
}
