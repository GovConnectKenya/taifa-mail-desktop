using System.Collections.ObjectModel;
using System.Text.RegularExpressions;
using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.Compose;

public interface IComposeApi
{
    Task<ApiSendResult> SendAsync(SendMailPayload payload, CancellationToken ct = default);
    Task<ApiDraftResult> SaveDraftAsync(SendMailPayload payload, CancellationToken ct = default);
    Task DeleteDraftAsync(long uid, string folder, CancellationToken ct = default);
    Task<string> UploadAsync(string filename, string mime, long size, Stream content, CancellationToken ct = default);
    /// <summary>The stored file status: pending, uploaded, scanning, ready, infected, expired, deleted.</summary>
    Task<string> FileStatusAsync(string fileId, CancellationToken ct = default) => Task.FromResult("ready");
    Task DeleteUploadAsync(string fileId, CancellationToken ct = default);
    Task<IReadOnlyList<string>> SuggestAsync(string query, CancellationToken ct = default);
    Task<IReadOnlyList<string>> StageForwardAsync(long uid, string folder, CancellationToken ct = default);
}

/// <summary>Adapts the real API to <see cref="IComposeApi"/>.</summary>
public sealed class ComposeApi : IComposeApi
{
    private readonly MailApi _api;
    public ComposeApi(MailApi api) => _api = api;
    public Task<ApiSendResult> SendAsync(SendMailPayload p, CancellationToken ct = default) => _api.SendAsync(p, ct);
    public Task<ApiDraftResult> SaveDraftAsync(SendMailPayload p, CancellationToken ct = default) => _api.SaveDraftAsync(p, ct);
    public Task DeleteDraftAsync(long uid, string folder, CancellationToken ct = default) => _api.DeleteAsync(uid, folder, false, ct);
    public async Task<string> UploadAsync(string filename, string mime, long size, Stream content, CancellationToken ct = default)
    {
        var ticket = await _api.CreateUploadAsync(filename, mime, size, ct);
        await _api.UploadBytesAsync(ticket.Upload, content, ct);
        var done = await _api.CompleteUploadAsync(ticket.File.Id, ct);
        return done.File.Id;
    }
    public Task DeleteUploadAsync(string fileId, CancellationToken ct = default) => _api.DeleteUploadAsync(fileId, ct);
    public async Task<string> FileStatusAsync(string fileId, CancellationToken ct = default) => (await _api.FileStatusAsync(fileId, ct)).File.Status;
    public async Task<IReadOnlyList<string>> SuggestAsync(string query, CancellationToken ct = default)
    {
        var list = await _api.ContactsAsync(query, 8, ct);
        return list.SelectMany(c => (c.Emails ?? new()).Where(e => !string.IsNullOrWhiteSpace(e.Value)).Select(e => string.IsNullOrWhiteSpace(c.DisplayName) ? e.Value : $"{c.DisplayName} <{e.Value}>")).Take(8).ToList();
    }
    public async Task<IReadOnlyList<string>> StageForwardAsync(long uid, string folder, CancellationToken ct = default) =>
        (await _api.StageAttachmentsAsync(uid, folder, ct)).Files.Select(f => f.FileId).ToList();
}

public sealed record RecipientChip(string Raw, string Address, string Display, bool Valid);

public enum AttachmentState { Uploading, Scanning, Ready, Failed, Infected }

public sealed partial class AttachmentVm : ObservableObject
{
    public AttachmentVm(string name, long size, string mime) { Name = name; Size = size; Mime = mime; }
    public string Name { get; }
    public long Size { get; }
    public string Mime { get; }
    public string? FileId { get; set; }
    public string SizeText => Models.ApiAttachmentExt.Human(Size);
    [ObservableProperty] private AttachmentState _state = AttachmentState.Uploading;
    [ObservableProperty] private string? _error;
}

/// <summary>One compose window. Autosaves a server draft after 3 seconds idle; Discard removes it and never saves.</summary>
public sealed partial class ComposeViewModel : ObservableObject
{
    public static readonly Regex AddressPattern = new(@"^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$", RegexOptions.Compiled);
    public const int AutosaveMs = 3000;

    private readonly IComposeApi _api;
    private readonly string _own;
    private CancellationTokenSource? _autosave;
    private long? _draftUid;
    private string _draftFolder = "Drafts";
    private bool _closed;
    private readonly List<string> _forwardFileIds = new();

    public ComposeViewModel(IComposeApi api, string ownAddress, ComposeSeed seed)
    {
        _api = api;
        _own = ownAddress;
        Seed = seed;
        Subject = seed.Subject;
        foreach (var a in seed.To) AddRecipient(To, a);
        foreach (var a in seed.Cc) AddRecipient(Cc, a);
        ShowCc = Cc.Count > 0;
    }

    public ComposeSeed Seed { get; }
    public string From => _own;
    public ObservableCollection<RecipientChip> To { get; } = new();
    public ObservableCollection<RecipientChip> Cc { get; } = new();
    public ObservableCollection<RecipientChip> Bcc { get; } = new();
    public ObservableCollection<AttachmentVm> Attachments { get; } = new();

    /// <summary>Supplied by the window: the editor's current HTML and plain text, without the quoted original.</summary>
    public Func<(string Html, string Text)> BodyProvider { get; set; } = () => ("", "");

    [ObservableProperty] private string _subject = "";
    [ObservableProperty] private bool _showCc;
    [ObservableProperty] private bool _showBcc;
    [ObservableProperty] private bool _sending;
    [ObservableProperty] private string _draftState = "";
    [ObservableProperty] private string? _error;
    [ObservableProperty] private string? _notice;

    public bool CanSend => !Sending && To.Any(c => c.Valid) && !To.Any(c => !c.Valid) && !Cc.Any(c => !c.Valid) && !Bcc.Any(c => !c.Valid) && Attachments.All(a => a.State == AttachmentState.Ready) && !SendUnconfirmed;

    public static IReadOnlyList<RecipientChip> Parse(string text)
    {
        var chips = new List<RecipientChip>();
        foreach (var part in Regex.Split(text ?? "", @"[;,\n]"))
        {
            var raw = part.Trim();
            if (raw.Length == 0) continue;
            var m = Regex.Match(raw, "^\\s*\"?([^\"<]*?)\"?\\s*<([^<>]+)>\\s*$");
            var address = (m.Success ? m.Groups[2].Value : raw).Trim();
            var name = m.Success ? m.Groups[1].Value.Trim() : "";
            chips.Add(new RecipientChip(raw, address, name.Length > 0 ? name : address, AddressPattern.IsMatch(address)));
        }
        return chips;
    }

    public void AddRecipient(ObservableCollection<RecipientChip> field, string text)
    {
        foreach (var c in Parse(text))
            if (!field.Any(x => string.Equals(x.Address, c.Address, StringComparison.OrdinalIgnoreCase))) field.Add(c);
        OnPropertyChanged(nameof(CanSend));
        Touch();
    }

    public void RemoveRecipient(ObservableCollection<RecipientChip> field, RecipientChip chip)
    {
        field.Remove(chip);
        OnPropertyChanged(nameof(CanSend));
        Touch();
    }

    public async Task<IReadOnlyList<string>> SuggestAsync(string query, IEnumerable<string>? threadAddresses = null, CancellationToken ct = default)
    {
        query = query.Trim();
        if (query.Length < 1) return Array.Empty<string>();
        var local = (threadAddresses ?? Array.Empty<string>()).Where(a => a.Contains(query, StringComparison.OrdinalIgnoreCase)).Take(4).ToList();
        try
        {
            var remote = await _api.SuggestAsync(query, ct);
            return local.Concat(remote).GroupBy(AvatarRule.NormalizeAddress).Select(g => g.First()).Take(8).ToList();
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { return local; }
    }

    private readonly List<Task> _uploads = new();
    /// <summary>Poll interval while a file is scanned for viruses. Tests shorten it.</summary>
    public TimeSpan ScanPoll { get; set; } = TimeSpan.FromSeconds(1.5);
    public int ScanAttempts { get; set; } = 120;

    public Task AddAttachmentAsync(string name, string mime, long size, Stream content, CancellationToken ct = default)
    {
        var task = UploadAndScanAsync(name, mime, size, content, ct);
        lock (_uploads) _uploads.Add(task);
        return task;
    }

    /// <summary>Upload, complete, then wait for the virus scan: a file is only attachable once it is ready.</summary>
    private async Task UploadAndScanAsync(string name, string mime, long size, Stream content, CancellationToken ct)
    {
        var vm = new AttachmentVm(name, size, string.IsNullOrEmpty(mime) ? "application/octet-stream" : mime);
        Attachments.Add(vm);
        OnPropertyChanged(nameof(CanSend));
        try
        {
            vm.FileId = await _api.UploadAsync(vm.Name, vm.Mime, size, content, ct);
            vm.State = AttachmentState.Scanning;
            for (var i = 0; i < ScanAttempts; i++)
            {
                var status = await _api.FileStatusAsync(vm.FileId, ct);
                if (status == "ready") { vm.State = AttachmentState.Ready; break; }
                if (status == "infected") { vm.State = AttachmentState.Infected; vm.Error = "This file was blocked by the virus scan."; break; }
                if (status is "expired" or "deleted") { vm.State = AttachmentState.Failed; vm.Error = "This file is no longer available."; break; }
                await Task.Delay(ScanPoll, ct);
            }
            if (vm.State == AttachmentState.Scanning) { vm.State = AttachmentState.Failed; vm.Error = "The virus scan did not finish. Remove the file and try again."; }
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            vm.State = AttachmentState.Failed;
            vm.Error = e.Message;
        }
        OnPropertyChanged(nameof(CanSend));
        Touch();
    }

    /// <summary>Waits for every upload and scan in flight (a draft must not reference a file that is not ready).</summary>
    public Task WaitForUploadsAsync()
    {
        Task[] pending;
        lock (_uploads) pending = _uploads.ToArray();
        return Task.WhenAll(pending);
    }

    public async Task RemoveAttachmentAsync(AttachmentVm a)
    {
        Attachments.Remove(a);
        OnPropertyChanged(nameof(CanSend));
        if (a.FileId is not null) { try { await _api.DeleteUploadAsync(a.FileId); } catch (Exception e) when (e is ApiRequestError or ApiTransportError) { } }
        Touch();
    }

    /// <summary>For Forward: stages the original's attachments so they travel with the message.</summary>
    public async Task StageForwardAttachmentsAsync()
    {
        if (Seed.Mode != ComposeMode.Forward || Seed.ForwardUid is null || Seed.ForwardAttachments is not { Count: > 0 }) return;
        try { _forwardFileIds.AddRange(await _api.StageForwardAsync(Seed.ForwardUid.Value, Seed.ForwardFolder ?? "INBOX")); }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { Notice = "The original attachments could not be added."; }
    }

    public int ForwardedAttachmentCount => _forwardFileIds.Count;

    private SendMailPayload Payload(bool draft)
    {
        var body = BodyProvider();
        var quote = Seed.QuotedHtml ?? (Seed.QuotedText is null ? null : System.Net.WebUtility.HtmlEncode(Seed.QuotedText).Replace("\n", "<br>"));
        var html = body.Html + (quote is null ? "" : $"<br><div>{System.Net.WebUtility.HtmlEncode(Seed.QuoteHeader ?? "").Replace("\n", "<br>")}</div><blockquote style=\"margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex\">{quote}</blockquote>");
        var text = body.Text + (Seed.QuotedText is null ? "" : $"\n{Seed.QuoteHeader}\n" + string.Join('\n', Seed.QuotedText.Replace("\r\n", "\n").Split('\n').Select(l => "> " + l)));
        var files = Attachments.Where(a => a.FileId is not null && a.State == AttachmentState.Ready).Select(a => a.FileId!).Concat(_forwardFileIds).ToList();
        return new SendMailPayload
        {
            To = To.Select(c => c.Address).ToList(),
            Cc = Cc.Count > 0 ? Cc.Select(c => c.Address).ToList() : null,
            Bcc = Bcc.Count > 0 ? Bcc.Select(c => c.Address).ToList() : null,
            Subject = Subject,
            Html = html,
            Text = text,
            InReplyTo = Seed.InReplyTo,
            References = Seed.References,
            ReplyUid = Seed.ReplyUid,
            ReplyFolder = Seed.ReplyFolder,
            FileIds = files.Count > 0 ? files : null,
            ReplaceUid = draft ? _draftUid : null,
            OpId = draft ? Guid.NewGuid().ToString("N") : null,
        };
    }

    /// <summary>Restarts the 3 second idle timer. Called on every edit.</summary>
    public void Touch()
    {
        if (_closed || Sending || _sendAttempted) return;
        _autosave?.Cancel();
        var cts = _autosave = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(AutosaveMs, cts.Token); } catch (OperationCanceledException) { return; }
            await SaveDraftNowAsync(cts.Token);
        });
    }

    private readonly SemaphoreSlim _draftGate = new(1, 1);
    private bool _sendAttempted;

    /// <summary>Saves are serialised: one at a time, each replacing the previous copy. A save waits for uploads that are still scanning.</summary>
    public async Task SaveDraftNowAsync(CancellationToken ct = default)
    {
        if (_closed || _sendAttempted) return;
        try { await WaitForUploadsAsync(); } catch (Exception) { }
        await _draftGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_closed || _sendAttempted) return;
            DraftState = "Saving";
            var r = await _api.SaveDraftAsync(Payload(draft: true), ct);
            if (_closed || _sendAttempted) { if (r.Uid is { } late) await SafeDelete(late, r.Folder); return; }
            _draftUid = r.Uid;
            _draftFolder = r.Folder;
            DraftState = "Saved";
        }
        catch (OperationCanceledException) { }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { DraftState = ""; }
        finally { _draftGate.Release(); }
    }

    private async Task SafeDelete(long uid, string folder)
    {
        try { await _api.DeleteDraftAsync(uid, folder); } catch (Exception e) when (e is ApiRequestError or ApiTransportError) { }
    }

    /// <summary>Waits for a save in flight, then removes the final stored copy.</summary>
    private async Task DeleteStoredDraftAsync()
    {
        await _draftGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_draftUid is { } uid) { _draftUid = null; await SafeDelete(uid, _draftFolder); }
        }
        finally { _draftGate.Release(); }
    }

    /// <summary>Discard removes any draft the autosave stored and never saves one.</summary>
    public async Task DiscardAsync()
    {
        _closed = true;
        _autosave?.Cancel();
        await DeleteStoredDraftAsync();
        foreach (var a in Attachments.Where(a => a.FileId is not null).ToList()) { try { await _api.DeleteUploadAsync(a.FileId!); } catch (Exception e) when (e is ApiRequestError or ApiTransportError) { } }
    }

    /// <summary>Closing the window with content saves it as a draft (spec 8.7), unless a send is under way or was attempted.</summary>
    public async Task SaveOnCloseAsync()
    {
        _autosave?.Cancel();
        if (_closed || Sending || _sendAttempted) return;
        var hasContent = To.Count > 0 || Subject.Length > 0 || BodyProvider().Text.Trim().Length > 0 || Attachments.Count > 0;
        if (hasContent) await SaveDraftNowAsync();
        _closed = true;
    }

    public const string UnconfirmedSend = "Taifa Mail did not confirm that the message was sent. Check your Sent folder before sending it again.";

    /// <summary>Returns true when the message went out and the window may close. A send is never retried automatically.</summary>
    public async Task<bool> SendAsync(CancellationToken ct = default)
    {
        if (!CanSend) return false;
        _autosave?.Cancel();
        Sending = true;
        _sendAttempted = true;
        Error = null;
        Notice = null;
        OnPropertyChanged(nameof(CanSend));
        try
        {
            await _draftGate.WaitAsync(ct).ConfigureAwait(false);
            _draftGate.Release();
            var result = await _api.SendAsync(Payload(draft: false), ct);
            var skipped = (result.Suppressed ?? new()).Concat(result.Refused ?? new()).ToList();
            _closed = true;
            await DeleteStoredDraftAsync();
            if (skipped.Count > 0) Notice = "Not delivered to: " + string.Join(", ", skipped);
            return true;
        }
        catch (ApiTransportError)
        {
            // a timeout may have happened after the server accepted the message: never retry on its own
            SendUnconfirmed = true;
            Error = UnconfirmedSend;
            return false;
        }
        catch (ApiRequestError e)
        {
            _sendAttempted = false;
            Error = e.Message;
            return false;
        }
        finally
        {
            Sending = false;
            OnPropertyChanged(nameof(CanSend));
        }
    }

    [ObservableProperty] private bool _sendUnconfirmed;
}
