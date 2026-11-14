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
    private CancellationTokenSource? _searchCts;
    private ThreadRow? _openRow;
    private long _nextBefore;
    private int _openTotal;
    private int _searchOffset;

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
    /// <summary>Asks "Delete forever?" before anything is removed from Trash or Junk. No confirmation means no deletion.</summary>
    public Func<int, Task<bool>>? ConfirmPermanentDelete { get; set; }

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
    [ObservableProperty] private bool _hasMoreOlder;
    [ObservableProperty] private bool _openUnavailableOffline;
    [ObservableProperty] private ApiQuota? _quota;
    [ObservableProperty] private bool _compact;
    [ObservableProperty] private bool _searchAllFolders;
    [ObservableProperty] private string _searchText = "";
    [ObservableProperty] private bool _searching;
    [ObservableProperty] private string? _searchNote;

    partial void OnCompactChanged(bool value) { foreach (var r in Threads) r.Compact = value; }

    public bool HasMore => Threads.Count < Total;
    public int EarlierCount => Math.Max(0, _openTotal - OpenMessages.Count);
    public int TotalUnread => Folders.FirstOrDefault(f => string.Equals(f.SpecialUse, "\\Inbox", StringComparison.OrdinalIgnoreCase) || f.Path == "INBOX")?.Unseen ?? 0;

    private ThreadRow Row(ApiConversationSummary item, bool outgoing, string listFolder) => new(item, outgoing, listFolder) { Compact = Compact };

    // ---- folders ----

    /// <summary>Paints cached folders and the cached first page immediately, then refreshes from the network.</summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        if (_cache is not null)
        {
            var cached = await Task.Run(() => _cache.LoadFolders(_api.MailboxId), ct);
            if (cached is { Count: > 0 })
            {
                ReplaceFolders(cached);
                SelectedFolder ??= Folders.FirstOrDefault(f => f.Path == "INBOX") ?? Folders.First();
                var path = SelectedFolder!.Path;
                if (await Task.Run(() => _cache.LoadThreads(_api.MailboxId, path), ct) is { } t) ShowThreads(t.Items, t.Total, path);
            }
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
            if (_cache is not null) _ = Task.Run(() => _cache.SaveFolders(_api.MailboxId, folders));
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

    public static int FolderOrder(ApiFolder f)
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

    public bool IsJunkFolder => SelectedFolder is { } f && FolderOrder(f) == 4;
    public bool IsTrashFolder => SelectedFolder is { } f && FolderOrder(f) == 6;

    // ---- the list ----

    /// <summary>
    /// One page of a folder. Sent, Drafts and other outgoing roles use the flat message list (a conversation row adds
    /// nothing there); everything else uses conversations.
    /// </summary>
    private async Task<(IReadOnlyList<ApiConversationSummary> Items, int Total)> FetchPageAsync(string folderPath, int offset, CancellationToken ct)
    {
        if (AvatarRule.IsOutgoingFolder(folderPath, Folders))
        {
            var flat = await _api.MessagesAsync(folderPath, PageSize, offset, ct);
            return (flat.Items.Select(m => new ApiConversationSummary($"{m.Folder}:{m.Uid}", m, 1, !m.Seen, new List<long> { m.Uid })).ToList(), flat.Total);
        }
        var page = await _api.ConversationsAsync(folderPath, PageSize, offset, ct);
        return (page.Items, page.Total);
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
            var (items, total) = await FetchPageAsync(folder.Path, 0, cts.Token);
            if (cts.IsCancellationRequested) return;
            Offline = false;
            if (_cache is not null) _ = Task.Run(() => _cache.SaveThreads(_api.MailboxId, folder.Path, items, total));
            ShowThreads(items, total, folder.Path);
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
        if (LoadingMore || Loading || !HasMore || SelectedFolder is null) return;
        if (Searching && SearchAllFolders) return;
        LoadingMore = true;
        var folder = SelectedFolder;
        try
        {
            IReadOnlyList<ApiConversationSummary> items;
            int total;
            var outgoing = AvatarRule.IsOutgoingFolder(folder.Path, Folders);
            if (Searching)
            {
                var res = await _api.SearchAsync(SearchText, folder.Path, PageSize, Threads.Count, ct);
                items = res.Items.Select(m => new ApiConversationSummary($"{m.Folder}:{m.Uid}", m, 1, !m.Seen, new List<long> { m.Uid })).ToList();
                total = res.Total;
                SearchNote = res.Incomplete ? "Showing the newest matches only." : null;
            }
            else (items, total) = await FetchPageAsync(folder.Path, Threads.Count, ct);
            if (SelectedFolder?.Path != folder.Path) return;
            var added = new List<ThreadRow>();
            var seen = Threads.Select(t => t.ThreadKey).ToHashSet();
            foreach (var item in items.Where(i => seen.Add(i.ThreadKey))) { var r = Row(item, outgoing, Searching ? item.Latest.Folder : folder.Path); Threads.Add(r); added.Add(r); }
            Total = total;
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
        foreach (var it in items) Threads.Add(Row(it, outgoing, folderPath));
        Total = total;
        IsEmpty = Threads.Count == 0;
        OnPropertyChanged(nameof(HasMore));
        ApplyAvatars(Threads);
    }

    /// <summary>
    /// Realtime and poll refresh: merges the newest page into the rows already shown. Rows keep their identity, so selection,
    /// scroll position and loaded pages survive; an echo of the user's own optimistic action changes nothing.
    /// </summary>
    public async Task MergeFirstPageAsync(CancellationToken ct = default)
    {
        if (SelectedFolder is not { } folder || Searching) return;
        try
        {
            var (fresh, total) = await FetchPageAsync(folder.Path, 0, ct);
            if (SelectedFolder?.Path != folder.Path || Searching) return;
            Offline = false;
            Total = total;
            var outgoing = AvatarRule.IsOutgoingFolder(folder.Path, Folders);
            var freshKeys = fresh.Select(f => f.ThreadKey).ToHashSet();
            var added = new List<ThreadRow>();
            for (var i = 0; i < fresh.Count; i++)
            {
                var it = fresh[i];
                var existing = Threads.FirstOrDefault(t => t.ThreadKey == it.ThreadKey);
                if (existing is null)
                {
                    var r = Row(it, outgoing, folder.Path);
                    Threads.Insert(Math.Min(i, Threads.Count), r);
                    added.Add(r);
                }
                else if (existing.Uid != it.Latest.Uid && !ReferenceEquals(existing, SelectedThread))
                {
                    var idx = Threads.IndexOf(existing);
                    var r = Row(it, outgoing, folder.Path);
                    Threads[idx] = r;
                    added.Add(r);
                }
                else existing.Apply(it);
            }
            // rows inside the refreshed window that the server no longer lists are gone
            foreach (var gone in Threads.Take(fresh.Count + added.Count).Where(t => !freshKeys.Contains(t.ThreadKey) && !ReferenceEquals(t, SelectedThread)).ToList())
                Threads.Remove(gone);
            IsEmpty = Threads.Count == 0;
            OnPropertyChanged(nameof(HasMore));
            if (_cache is not null) { var snapshot = Threads.Take(100).Select(t => t.Model).ToList(); _ = Task.Run(() => _cache.SaveThreads(_api.MailboxId, folder.Path, snapshot, total)); }
            await ResolveAvatarsAsync(added, ct);
        }
        catch (OperationCanceledException) { }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
    }

    public async Task ReconcileAsync(CancellationToken ct = default)
    {
        await RefreshFoldersAsync(ct);
        await MergeFirstPageAsync(ct);
    }

    // ---- search ----

    /// <summary>Searches the current folder or, for all folders, fans out client side. Newer queries cancel older ones.</summary>
    public async Task SearchAsync(string text, CancellationToken ct = default)
    {
        _searchCts?.Cancel();
        text = (text ?? "").Trim();
        SearchText = text;
        SearchNote = null;
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
                // The API searches one folder per call; Junk and Trash are left out as the spec says.
                var targets = Folders.Where(f => FolderOrder(f) is not (4 or 6)).Take(12).ToList();
                var pages = await Task.WhenAll(targets.Select(async f =>
                {
                    try { return await _api.SearchAsync(text, f.Path, 25, 0, cts.Token); }
                    catch (ApiRequestError) { return new ApiMailList(f.Path, 0, 25, 0, new()); }
                }));
                var merged = pages.SelectMany(p => p.Items).OrderByDescending(m => DateTimeOffset.TryParse(m.Date, out var d) ? d : DateTimeOffset.MinValue).Take(PageSize).ToList();
                res = new ApiMailList("*", merged.Count, PageSize, 0, merged, pages.Any(p => p.Incomplete));
            }
            else res = await _api.SearchAsync(text, SelectedFolder.Path, PageSize, 0, cts.Token);
            if (cts.IsCancellationRequested) return;
            var outgoing = AvatarRule.IsOutgoingFolder(SelectedFolder.Path, Folders);
            Threads.Clear();
            foreach (var m in res.Items)
                Threads.Add(Row(new ApiConversationSummary($"{m.Folder}:{m.Uid}", m, 1, !m.Seen, new List<long> { m.Uid }), outgoing, m.Folder));
            _searchOffset = Threads.Count;
            Total = SearchAllFolders ? Threads.Count : res.Total;
            SearchNote = res.Incomplete ? "Showing the newest matches only." : null;
            IsEmpty = Threads.Count == 0;
            OnPropertyChanged(nameof(HasMore));
            await ResolveAvatarsAsync(Threads, cts.Token);
        }
        catch (OperationCanceledException) { }
        catch (ApiTransportError) { Offline = true; }
        catch (ApiRequestError e) { Error = e.Message; }
        finally { if (_searchCts == cts) Loading = false; }
    }

    // ---- avatars ----

    private async Task ResolveAvatarsAsync(IEnumerable<ThreadRow> rows, CancellationToken ct)
    {
        var list = rows.ToList();
        var need = list.Select(r => r.AvatarAddress).Where(a => a.Length > 0 && !_avatars.ContainsKey(a)).Distinct().Take(100).ToList();
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
        ApplyAvatars(list);
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

    // ---- the open conversation ----

    /// <summary>
    /// Opens a thread. The row clears at once and the server mark-read goes out immediately, independent of the body load,
    /// so a body request that gets cancelled by a newer selection never reverts a thread the user did open.
    /// </summary>
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
        Task? mark = null;
        if (row.Unread)
        {
            row.Unread = false;
            AdjustUnseen(row.ActionFolder, -1);
            mark = MarkReadAsync(row);
        }
        try
        {
            var window = await _api.ConversationAsync(row.Uid, row.Folder, 20, null, cts.Token);
            if (cts.IsCancellationRequested) return;
            if (_cache is not null) _ = Task.Run(() => _cache.SaveConversation(_api.MailboxId, row.Folder, row.Uid, window));
            ShowWindow(window);
            await ResolveCardAvatarsAsync(OpenMessages.ToList(), cts.Token);
        }
        catch (OperationCanceledException) { }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            if (e is ApiTransportError)
            {
                Offline = true;
                var cached = _cache is null ? null : await Task.Run(() => _cache.LoadConversation(_api.MailboxId, row.Folder, row.Uid));
                if (cached is not null) { ShowWindow(cached); OpenError = null; }
                else { OpenUnavailableOffline = true; OpenError = "Not available offline"; }
            }
            else OpenError = e.Message;
        }
        finally { if (_openCts == cts) OpenLoading = false; }
        if (mark is not null) await mark;
    }

    private async Task MarkReadAsync(ThreadRow row)
    {
        try
        {
            var result = await _api.MarkThreadReadAsync(row.Uid, row.Folder);
            if (!result.Complete) throw new ApiRequestError("incomplete", 0);
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            row.Unread = true;
            AdjustUnseen(row.ActionFolder, +1);
            if (ReferenceEquals(SelectedThread, row)) OpenError = "Could not mark as read";
        }
    }

    private void ShowWindow(ApiConversationWindow window)
    {
        HasMoreOlder = window.HasMoreOlder;
        _nextBefore = window.NextBefore;
        _openTotal = window.Total;
        OpenMessages.Clear();
        var ordered = window.Messages.OrderBy(m => DateTimeOffset.TryParse(m.Date, out var d) ? d : DateTimeOffset.MinValue).ToList();
        for (var i = 0; i < ordered.Count; i++)
        {
            var card = new MessageCardVm(ordered[i], OwnAddress, isLatest: i == ordered.Count - 1);
            // a trusted sender never auto-loads images on a message that carries any authentication warning
            card.AllowImages = TrustedImageSenders.Contains(card.AvatarAddress) && !card.HasAuthBanner;
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

    /// <summary>Adjusts the unread count of the folder the thread belongs to, whatever is selected right now.</summary>
    private void AdjustUnseen(string folderPath, int delta)
    {
        var i = Folders.ToList().FindIndex(f => f.Path == folderPath);
        if (i < 0 || Folders[i].Unseen is not { } unseen) return;
        var updated = Folders[i] with { Unseen = Math.Max(0, unseen + delta) };
        Folders[i] = updated;
        if (SelectedFolder?.Path == folderPath) SelectedFolder = updated;
        OnPropertyChanged(nameof(TotalUnread));
    }
}
