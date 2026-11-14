using TaifaMail.Core.Cache;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;

namespace TaifaMail.App.Services;

/// <summary>Everything the main page needs from the outside, so the same page runs on the real API or on preview data.</summary>
public sealed class ShellContext
{
    public required IMailApi Mail { get; init; }
    public required IAuthApi Auth { get; init; }
    public required MailboxMe Me { get; init; }
    public required string ApiBase { get; init; }
    public MailApi? RealMail { get; init; }
    public OfflineCache? Cache { get; init; }
    public LocalSettings Settings { get; init; } = new();
    public Func<Task> SignOut { get; init; } = () => Task.CompletedTask;
    public Func<string, Task> SwitchMailbox { get; init; } = _ => Task.CompletedTask;
    public bool IsPreview { get; init; }
}
