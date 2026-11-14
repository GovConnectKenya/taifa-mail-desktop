#if PREVIEW_DATA
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.App.Preview;

/// <summary>
/// Fixture data for the Debug only preview mode. Every name and address is invented and uses the reserved
/// example.go.ke style domain. This file is not compiled into Release (see the csproj).
/// </summary>
public static class PreviewData
{
    public const string FixtureMarker = "TAIFA_PREVIEW_FIXTURE_ONLY_DEBUG";

    public const string Own = "demo.officer@example.go.ke";
    public static readonly MailboxMe Me = new("00000000-0000-0000-0000-000000000001", Own, null, "Demo Officer", null, null);

    public static List<ApiFolder> Folders() => new()
    {
        new("Inbox", "INBOX", "\\Inbox", 12, 148),
        new("Drafts", "Drafts", "\\Drafts", 0, 2),
        new("Sent", "Sent", "\\Sent", 0, 61),
        new("Archive", "Archive", "\\Archive", 0, 0),
        new("Junk", "Junk", "\\Junk", 3, 9),
        new("Trash", "Trash", "\\Trash", 0, 14),
        new("Projects", "Projects", null, 1, 22),
    };

    private static readonly (string Name, string Addr, string Subject, string Snippet, bool Seen, bool Flag, bool Att, int Count, string Level)[] Rows =
    {
        ("Amina Wanjiru", "amina.wanjiru@example.go.ke", "Quarterly budget review: figures attached", "Please find the consolidated figures for the third quarter. I have flagged two lines that need your sign off before Friday.", false, true, true, 4, ""),
        ("Brian Otieno", "brian.otieno@example.go.ke", "Re: Site visit schedule for Nakuru", "Thursday works for the team. We can leave at 07:30 and be on site by ten if the road is clear.", false, false, false, 2, ""),
        ("Service Desk", "servicedesk@example.go.ke", "Your password will expire in 5 days", "Sign in to the staff portal to choose a new password. This message was sent to all staff.", false, false, false, 1, "warning"),
        ("Grace Muthoni", "grace.muthoni@example.go.ke", "Minutes of the procurement committee", "Attached are the minutes from Tuesday. Corrections by close of business tomorrow, please.", true, false, true, 1, ""),
        ("Registry Office", "registry@example.go.ke", "New circular: records retention schedule", "The updated records retention schedule takes effect on the first of next month. Heads of department should circulate it.", true, false, false, 1, ""),
        ("Peter Kamau", "peter.kamau@example.go.ke", "Lunch on Friday?", "A few of us are going to the place near the market. Join us if you are free around one.", true, false, false, 3, ""),
        ("Finance Office", "finance@example.go.ke", "Imprest surrender reminder", "Outstanding imprests must be surrendered within seven days of the activity. Two of yours are open.", true, true, false, 1, ""),
        ("Lucy Achieng", "lucy.achieng@example.go.ke", "Training calendar for next quarter", "Draft calendar below. Let me know which sessions your team can attend so I can book the venue.", true, false, false, 1, ""),
    };

    public static List<ApiConversationSummary> Threads(int count = 60)
    {
        var list = new List<ApiConversationSummary>();
        var now = DateTimeOffset.Now;
        for (var i = 0; i < count; i++)
        {
            var r = Rows[i % Rows.Length];
            var when = now.AddMinutes(-35 - i * 97);
            var summary = new ApiMailSummary(1000 + i, "INBOX", $"<preview-{i}@example.go.ke>", i < Rows.Length ? r.Subject : $"{r.Subject} ({i / Rows.Length + 1})",
                r.Name, r.Addr, new() { Own }, when.ToString("o"), r.Seen || i >= Rows.Length, r.Flag, false, r.Att, r.Snippet,
                r.Level.Length > 0 ? r.Level : null, r.Level.Length > 0 ? false : true, r.Level.Length > 0);
            list.Add(new ApiConversationSummary($"thread-{i}", summary, r.Count, !(r.Seen || i >= Rows.Length), new() { 1000 + i }));
        }
        return list;
    }

    private const string Html =
        "<p>Hello,</p><p>Please find the consolidated figures for the third quarter. Two lines need your sign off before <b>Friday</b>:</p>" +
        "<ul><li>Transport and travel: variance of 4.2 percent against the approved estimate</li><li>Training: carried forward to the next quarter</li></ul>" +
        "<p>The full workbook is attached. The dashboard is also on the <a href=\"https://reports.example.go.ke/q3\">finance reports page</a>.</p>" +
        "<p><img src=\"https://images.example.test/q3-chart.png\" alt=\"Quarterly chart\" width=\"480\"></p><p>Regards,<br>Amina</p>";

    public static ApiConversationWindow Conversation(long uid)
    {
        var row = Rows[(int)((uid - 1000) % Rows.Length)];
        var when = DateTimeOffset.Now.AddHours(-3);
        ApiMailDetail Msg(long u, string from, string addr, string text, string? html, DateTimeOffset at, bool att, ApiAuthWarning? warn = null) =>
            new(u, "INBOX", 1, row.Subject, from, addr, new() { Own, "grace.muthoni@example.go.ke" }, new() { "peter.kamau@example.go.ke" }, at.ToString("o"),
                true, false, false, $"<m{u}@example.go.ke>", null, null, text, html,
                att ? new() { new("2", "Q3-consolidated-figures.xlsx", "application/vnd.ms-excel", 184_320), new("3", "Variance-notes.pdf", "application/pdf", 912_384) } : null, warn, !(warn is not null));
        var msgs = new List<ApiMailDetail>();
        if (row.Count > 1)
        {
            msgs.Add(Msg(uid - 500, "Peter Kamau", "peter.kamau@example.go.ke", "Thanks for sending this over. I will review the transport lines tonight and come back to you in the morning.", null, when.AddHours(-20), false));
            msgs.Add(Msg(uid - 400, "Demo Officer", Own, "Noted. Please also check the training line, I think it was moved from the second quarter.", null, when.AddHours(-9), false));
        }
        var warn = row.Level == "warning" ? new ApiAuthWarning("warning", "dmarc_fail", "This message could not be verified", "It claims to be from your service desk but failed sender checks. Be careful with links and attachments.", true) : null;
        msgs.Add(row.Level == "warning"
            ? Msg(uid, row.Name, row.Addr, "Your password expires in 5 days. Sign in to the staff portal to choose a new one.", null, when, false, warn)
            : Msg(uid, row.Name, row.Addr, "Hello, please find the figures attached. Regards, Amina", row.Name == "Amina Wanjiru" ? Html : null, when, row.Att));
        return new ApiConversationWindow(msgs, 1, msgs.Count, false, 0);
    }
}

/// <summary>Fake mailbox API. Switches let screenshots show loading, empty, error and offline states.</summary>
public sealed class PreviewMail : IMailApi
{
    public string MailboxId => PreviewData.Me.MailboxId;
    public TimeSpan Delay { get; set; } = TimeSpan.FromMilliseconds(30);
    public bool Offline { get; set; }
    public bool Fail { get; set; }
    public bool EmptyArchive { get; set; } = true;

    private async Task Gate(CancellationToken ct)
    {
        await Task.Delay(Delay, ct);
        if (Offline) throw new ApiTransportError("offline");
        if (Fail) throw new ApiRequestError("Taifa Mail could not complete the request.", 502);
    }

    public async Task<List<ApiFolder>> FoldersAsync(CancellationToken ct = default) { await Gate(ct); return PreviewData.Folders(); }

    public async Task<ApiConversationList> ConversationsAsync(string folder, int limit = 50, int offset = 0, CancellationToken ct = default)
    {
        await Gate(ct);
        var all = folder == "INBOX" ? PreviewData.Threads(60) : new List<ApiConversationSummary>();
        return new ApiConversationList(folder, all.Count, limit, offset, all.Skip(offset).Take(limit).ToList());
    }

    public Task<ApiMailList> SearchAsync(string text, string folder = "INBOX", int limit = 50, int offset = 0, CancellationToken ct = default) =>
        Task.FromResult(new ApiMailList(folder, 0, limit, offset, new()));

    public async Task<ApiConversationWindow> ConversationAsync(long uid, string folder, int limit = 20, long? before = null, CancellationToken ct = default)
    {
        await Gate(ct);
        return PreviewData.Conversation(uid);
    }

    public async Task<ApiMarkReadResult> MarkThreadReadAsync(long uid, string folder, CancellationToken ct = default) { await Gate(ct); return new ApiMarkReadResult(1, true); }
    public Task SetFlagsAsync(long uid, string folder, bool? seen = null, bool? flagged = null, CancellationToken ct = default) => Task.CompletedTask;
    public Task<AvatarBatchResponse> AvatarsAsync(IReadOnlyCollection<string> emails, CancellationToken ct = default) => Task.FromResult(new AvatarBatchResponse(new()));
}

public sealed class PreviewAuth : IAuthApi
{
    public Task<LoginResult> LoginAsync(string address, string password, CancellationToken ct = default) => Task.FromResult(LoginResult.NeedsSecondFactor(address));
    public Task RequestLoginCodeAsync(string address, CancellationToken ct = default) => Task.CompletedTask;
    public Task<LoginResult> VerifyLoginCodeAsync(string address, string code, CancellationToken ct = default) => Task.FromResult(LoginResult.NeedsSecondFactor(address));
    public Task<LoginResult> VerifySecondFactorAsync(string code, CancellationToken ct = default) => Task.FromResult(LoginResult.NeedsSecondFactor(PreviewData.Own));
    public Task ChallengeSecondFactorAsync(CancellationToken ct = default) => Task.CompletedTask;
    public Task<MailboxMe> MeAsync(CancellationToken ct = default) => Task.FromResult(PreviewData.Me);
    public Task<List<SwitchableMailbox>> SwitchableAsync(CancellationToken ct = default) =>
        Task.FromResult(new List<SwitchableMailbox> { new("00000000-0000-0000-0000-000000000002", "records@example.go.ke", "Records Office", null, "full") });
    public Task SwitchAsync(string mailboxId, CancellationToken ct = default) => Task.CompletedTask;
    public Task LogoutAsync(CancellationToken ct = default) => Task.CompletedTask;
}
#endif
