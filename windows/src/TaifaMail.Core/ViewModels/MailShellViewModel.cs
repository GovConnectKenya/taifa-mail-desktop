using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Cache;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.ViewModels;

/// <summary>
/// Folders, thread list and the open conversation. Everything that touches the network is async and
/// the UI only sees collections and flags. Reads are optimistic and roll back on failure.
/// </summary>
public sealed partial class MailShellViewModel : ObservableObject
{
    public const int PageSize = 50;

    private readonly IMailApi _api;
    private readonly OfflineCache? _cache;
    private readonly Dictionary<string, AvatarBatchEntry> _avatars = new();
    private CancellationTokenSource? _openCts;
    private CancellationTokenSource? _listCts;

    public MailShellViewModel(IMailApi api, string apiBase, OfflineCache? cache = null)
    {
        _api = api;
        ApiBase = apiBase;
        _cache = cache;
    }

    public string ApiBase { get; }
    public ObservableCollection<ApiFolder> Folders { get; } = new();
    public ObservableCollection<ThreadRow> Threads { get; } = new();
    public ObservableCollection<MessageCardVm> OpenMessages { get; } = new();
    public string OwnAddress { get; set; } = "";
    /// <summary>Senders the user trusts for remote images (mailbox setting trusted_image_senders).</summary>
    public HashSet<string> TrustedImageSenders { get; } = new(StringComparer.OrdinalIgnoreCase);

    [ObservableProperty] private ApiFolder? _selectedFolder;
    [ObservableProperty] private ThreadRow? _selectedThread;
    [ObservableProperty] private bool _loading;
    [ObservableProperty] private bool _loadingMore;
    [ObservableProperty] private bool _offline;
    [ObservableProperty] private string? _error;
    [ObservableProperty] private int _total;
    [ObservableProperty] private bool _isEmpty;
    [ObservableProperty] private bool _openLoading;
    [ObservableProperty] private string? _openError;

    public bool HasMore => Threads.Count < Total;
    public int TotalUnread => Folders.FirstOrDefault(f => string.Equals(f.SpecialUse, "\\Inbox", StringComparison.OrdinalIgnoreCase) || f.Path == "INBOX")?.Unseen ?? 0;

    /// <summary>Paints cached folders and the cached first page immediately, then refreshes from the network.</summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        if (_cache?.LoadFolders(_api.MailboxId) is { Count: > 0 } cached)
        {
            ReplaceFolders(cached);
            SelectedFolder ??= Folders.FirstOrDefault(f => f.Path == "INBOX") ?? Folders.First();
            if (_cache.LoadThreads(_api.MailboxId, SelectedFolder!.Path) is { } t) ShowThreads(t.Items, t.Total, SelectedFolder.Path);
        }
        await RefreshFoldersAsync(ct);
        SelectedFolder ??= Folders.FirstOrDefault(f => f.Path == "INBOX") ?? Folders.FirstOrDefault();
        if (SelectedFolder is not null) await LoadFolderAsync(SelectedFolder, ct);
        try { Quota = await _api.QuotaAsync(ct); } catch (Exception e) when (e is ApiRequestError or ApiTransportError) { }
    }

    public async Task RefreshFoldersAsync(CancellationToken ct = default)
    {
        try
        {
            var folders = await _api.FoldersAsync(ct);
            Offline = false;
            _cache?.SaveFolders(_api.MailboxId, folders);
            ReplaceFolders(folders);
        }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
    }

    private void ReplaceFolders(IReadOnlyList<ApiFolder> folders)
    {
        var selectedPath = SelectedFolder?.Path;
        Folders.Clear();
        foreach (var f in folders.OrderBy(FolderOrder).ThenBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase)) Folders.Add(f);
        if (selectedPath is not null) SelectedFolder = Folders.FirstOrDefault(f => f.Path == selectedPath);
        OnPropertyChanged(nameof(TotalUnread));
    }

    private static int FolderOrder(ApiFolder f)
    {
        var key = (f.SpecialUse ?? f.Path).ToLowerInvariant();
        if (f.Path == "INBOX" || key.Contains("inbox")) return 0;
        if (key.Contains("sent")) return 1;
        if (key.Contains("draft")) return 2;
        if (key.Contains("archive")) return 3;
        if (key.Contains("junk") || key.Contains("spam")) return 4;
        if (key.Contains("quarantine")) return 5;
        if (key.Contains("trash") || key.Contains("deleted")) return 6;
        return 7;
    }

    public async Task LoadFolderAsync(ApiFolder folder, CancellationToken ct = default)
    {
        _listCts?.Cancel();
        var cts = _listCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        SelectedFolder = folder;
        Loading = true;
        Error = null;
        try
        {
            var page = await _api.ConversationsAsync(folder.Path, PageSize, 0, cts.Token);
            if (cts.IsCancellationRequested) return;
            Offline = false;
            _cache?.SaveThreads(_api.MailboxId, folder.Path, page.Items, page.Total);
            ShowThreads(page.Items, page.Total, folder.Path);
            await ResolveAvatarsAsync(Threads, cts.Token);
        }
        catch (OperationCanceledException) { }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
        finally { if (_listCts == cts) Loading = false; }
    }

    /// <summary>Incremental loading: fetches the next page and appends it. Safe to call repeatedly from the scroll handler.</summary>
    public async Task LoadMoreAsync(CancellationToken ct = default)
    {
        if (LoadingMore || Loading || Searching || !HasMore || SelectedFolder is null) return;
        LoadingMore = true;
        var folder = SelectedFolder;
        try
        {
            var page = await _api.ConversationsAsync(folder.Path, PageSize, Threads.Count, ct);
            if (SelectedFolder?.Path != folder.Path) return;
            var outgoing = AvatarRule.IsOutgoingFolder(folder.Path, Folders);
            var added = new List<ThreadRow>();
            var seen = Threads.Select(t => t.ThreadKey).ToHashSet();
            foreach (var item in page.Items.Where(i => seen.Add(i.ThreadKey))) { var r = Row(item, outgoing); Threads.Add(r); added.Add(r); }
            Total = page.Total;
            OnPropertyChanged(nameof(HasMore));
            await ResolveAvatarsAsync(added, ct);
        }
        catch (OperationCanceledException) { }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
        finally { LoadingMore = false; }
    }

    private void ShowThreads(IReadOnlyList<ApiConversationSummary> items, int total, string folderPath)
    {
        var outgoing = AvatarRule.IsOutgoingFolder(folderPath, Folders);
        Threads.Clear();
        foreach (var it in items) Threads.Add(Row(it, outgoing));
        Total = total;
        IsEmpty = Threads.Count == 0;
        OnPropertyChanged(nameof(HasMore));
        ApplyAvatars(Threads);
    }

    private async Task ResolveAvatarsAsync(IEnumerable<ThreadRow> rows, CancellationToken ct)
    {
        var need = rows.Select(r => r.AvatarAddress).Where(a => a.Length > 0 && !_avatars.ContainsKey(a)).Distinct().Take(100).ToList();
        if (need.Count > 0)
        {
            try
            {
                var res = await _api.AvatarsAsync(need, ct);
                foreach (var (k, v) in res.Results) _avatars[AvatarRule.NormalizeAddress(k)] = v;
                foreach (var a in need) _avatars.TryAdd(a, new AvatarBatchEntry(null, null, null, null));
            }
            catch (ApiRequestError) { }
            catch (ApiTransportError) { }
        }
        ApplyAvatars(rows);
    }

    private void ApplyAvatars(IEnumerable<ThreadRow> rows)
    {
        var outgoing = SelectedFolder is not null && AvatarRule.IsOutgoingFolder(SelectedFolder.Path, Folders);
        foreach (var r in rows)
        {
            _avatars.TryGetValue(r.AvatarAddress, out var entry);
            r.Avatar = AvatarRule.Decide(r.AvatarAddress, r.DisplayName, entry, r.Auth, outgoing ? AvatarTrust.Open : AvatarTrust.Gated, ApiBase);
        }
    }

    /// <summary>Opens a thread and marks it read optimistically: the row clears at once, and is restored if the server refuses.</summary>
    private ThreadRow? _openRow;
    private long _nextBefore;
    [ObservableProperty] private bool _hasMoreOlder;
    [ObservableProperty] private bool _openUnavailableOffline;

    public async Task OpenAsync(ThreadRow row, CancellationToken ct = default)
    {
        _openRow = row;
        OpenUnavailableOffline = false;
        HasMoreOlder = false;
        _openCts?.Cancel();
        var cts = _openCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        SelectedThread = row;
        OpenMessages.Clear();
        OpenError = null;
        OpenLoading = true;
        var wasUnread = row.Unread;
        var folder = SelectedFolder;
        var previousUnseen = folder?.Unseen ?? 0;
        if (wasUnread) { row.Unread = false; AdjustUnseen(-1); }
        try
        {
            var window = await _api.ConversationAsync(row.Uid, row.Folder, 20, null, cts.Token);
            if (cts.IsCancellationRequested) return;
            _cache?.SaveConversation(_api.MailboxId, row.Folder, row.Uid, window);
            ShowWindow(window);
            await ResolveCardAvatarsAsync(OpenMessages.ToList(), cts.Token);
            if (wasUnread)
            {
                try
                {
                    var result = await _api.MarkThreadReadAsync(row.Uid, row.Folder, cts.Token);
                    if (!result.Complete) throw new ApiRequestError("incomplete", 0);
                }
                catch (Exception e) when (e is ApiRequestError or ApiTransportError)
                {
                    row.Unread = true;
                    AdjustUnseen(+1);
                    OpenError = "Could not mark as read";
                }
            }
        }
        catch (OperationCanceledException) { if (wasUnread) { row.Unread = true; AdjustUnseen(+1); } }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            if (wasUnread) { row.Unread = true; AdjustUnseen(+1); }
            if (e is ApiTransportError)
            {
                Offline = true;
                var cached = _cache?.LoadConversation(_api.MailboxId, row.Folder, row.Uid);
                if (cached is not null) { ShowWindow(cached); OpenError = null; }
                else { OpenUnavailableOffline = true; OpenError = "Not available offline"; }
            }
            else OpenError = e.Message;
        }
        finally { if (_openCts == cts) OpenLoading = false; }
        _ = previousUnseen;
    }

    [ObservableProperty] private ApiQuota? _quota;
    [ObservableProperty] private bool _compact;
    [ObservableProperty] private bool _searchAllFolders;
    partial void OnCompactChanged(bool value) { foreach (var r in Threads) r.Compact = value; }
    private ThreadRow Row(ApiConversationSummary item, bool outgoing) => new(item, outgoing) { Compact = Compact };

    private void ShowWindow(ApiConversationWindow window)
    {
        HasMoreOlder = window.HasMoreOlder;
        _nextBefore = window.NextBefore;
        OpenMessages.Clear();
        var ordered = window.Messages.OrderBy(m => DateTimeOffset.TryParse(m.Date, out var d) ? d : DateTimeOffset.MinValue).ToList();
        for (var i = 0; i < ordered.Count; i++)
        {
            var card = new MessageCardVm(ordered[i], OwnAddress, isLatest: i == ordered.Count - 1);
            card.AllowImages = TrustedImageSenders.Contains(card.AvatarAddress);
            OpenMessages.Add(card);
        }
    }

    /// <summary>"Show earlier messages": fetches the next older window and puts it above the open messages.</summary>
    public async Task LoadOlderAsync(CancellationToken ct = default)
    {
        if (_openRow is null || !HasMoreOlder) return;
        try
        {
            var w = await _api.OlderAsync(_openRow.Uid, _openRow.Folder, _nextBefore, ct);
            HasMoreOlder = w.HasMoreOlder;
            _nextBefore = w.NextBefore;
            var older = w.Messages.OrderBy(m => DateTimeOffset.TryParse(m.Date, out var d) ? d : DateTimeOffset.MinValue).ToList();
            var cards = older.Select(m => new MessageCardVm(m, OwnAddress, false)).ToList();
            for (var i = cards.Count - 1; i >= 0; i--) OpenMessages.Insert(0, cards[i]);
            await ResolveCardAvatarsAsync(cards, ct);
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { Notice?.Invoke("Could not load earlier messages", null); }
    }

    private async Task ResolveCardAvatarsAsync(IReadOnlyList<MessageCardVm> cards, CancellationToken ct)
    {
        var need = cards.Select(c => c.AvatarAddress).Where(a => a.Length > 0 && !_avatars.ContainsKey(a)).Distinct().Take(100).ToList();
        if (need.Count > 0)
        {
            try
            {
                var res = await _api.AvatarsAsync(need, ct);
                foreach (var (k, v) in res.Results) _avatars[AvatarRule.NormalizeAddress(k)] = v;
                foreach (var a in need) _avatars.TryAdd(a, new AvatarBatchEntry(null, null, null, null));
            }
            catch (ApiRequestError) { }
            catch (ApiTransportError) { }
        }
        var outgoing = SelectedFolder is not null && AvatarRule.IsOutgoingFolder(SelectedFolder.Path, Folders);
        foreach (var c in cards)
        {
            _avatars.TryGetValue(c.AvatarAddress, out var entry);
            c.Avatar = AvatarRule.Decide(c.AvatarAddress, c.DisplayName, entry, c.Auth, outgoing ? AvatarTrust.Open : AvatarTrust.Gated, ApiBase);
        }
    }

    private void AdjustUnseen(int delta)
    {
        if (SelectedFolder is null) return;
        var i = Folders.IndexOf(SelectedFolder);
        if (i < 0) return;
        var f = Folders[i];
        var updated = f with { Unseen = Math.Max(0, f.Unseen + delta) };
        Folders[i] = updated;
        SelectedFolder = updated;
        OnPropertyChanged(nameof(TotalUnread));
    }

    [ObservableProperty] private string _searchText = "";
    [ObservableProperty] private bool _searching;
    private CancellationTokenSource? _searchCts;

    /// <summary>Searches the current folder. An empty query returns to the folder list. Newer queries cancel older ones.</summary>
    public async Task SearchAsync(string text, CancellationToken ct = default)
    {
        _searchCts?.Cancel();
        text = (text ?? "").Trim();
        SearchText = text;
        if (SelectedFolder is null) return;
        if (text.Length == 0) { Searching = false; await LoadFolderAsync(SelectedFolder, ct); return; }
        var cts = _searchCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Searching = true;
        Loading = true;
        Error = null;
        try
        {
            ApiMailList res;
            if (SearchAllFolders)
            {
                // The API searches one folder per call, so fan out client side and merge newest first (contract 5.2).
                var targets = Folders.Where(f => FolderOrder(f) < 6 || FolderOrder(f) == 7).Take(12).ToList();
                var pages = await Task.WhenAll(targets.Select(async f =>
                {
                    try { return await _api.SearchAsync(text, f.Path, 25, 0, cts.Token); }
                    catch (ApiRequestError) { return new ApiMailList(f.Path, 0, 25, 0, new()); }
                }));
                var merged = pages.SelectMany(p => p.Items).OrderByDescending(m => DateTimeOffset.TryParse(m.Date, out var d) ? d : DateTimeOffset.MinValue).Take(PageSize).ToList();
                res = new ApiMailList("*", merged.Count, PageSize, 0, merged);
            }
            else res = await _api.SearchAsync(text, SelectedFolder.Path, PageSize, 0, cts.Token);
            if (cts.IsCancellationRequested) return;
            var outgoing = AvatarRule.IsOutgoingFolder(SelectedFolder.Path, Folders);
            Threads.Clear();
            foreach (var m in res.Items)
                Threads.Add(Row(new ApiConversationSummary($"{m.Folder}:{m.Uid}", m, 1, !m.Seen, new List<long> { m.Uid }), outgoing));
            Total = res.Total;
            IsEmpty = Threads.Count == 0;
            OnPropertyChanged(nameof(HasMore));
            await ResolveAvatarsAsync(Threads, cts.Token);
        }
        catch (OperationCanceledException) { }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
        finally { if (_searchCts == cts) Loading = false; }
    }

    public async Task ReconcileAsync(CancellationToken ct = default)
    {
        await RefreshFoldersAsync(ct);
        if (SelectedFolder is { } f) await LoadFolderAsync(f, ct);
    }
}
