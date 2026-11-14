using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.ViewModels;

/// <summary>Archive, delete, junk, move, flag, read state. Optimistic, rolled back on failure, with an undo where the API allows.</summary>
public sealed partial class MailShellViewModel
{
    /// <summary>Raised for the toast: message and an optional undo. Undo stays valid for about 8 seconds in the UI.</summary>
    public event Action<string, Func<Task>?>? Notice;

    public const string OfflineTip = "Not available offline";

    public string? FolderByRole(string role)
    {
        foreach (var f in Folders)
        {
            var key = (f.SpecialUse ?? f.Path).ToLowerInvariant();
            if (role == "archive" && key.Contains("archive")) return f.Path;
            if (role == "trash" && (key.Contains("trash") || key.Contains("deleted"))) return f.Path;
            if (role == "junk" && (key.Contains("junk") || key.Contains("spam"))) return f.Path;
        }
        return role switch { "archive" => "Archive", "trash" => "Trash", "junk" => "Junk", _ => null };
    }

    private bool Blocked()
    {
        if (!Offline) return false;
        Notice?.Invoke(OfflineTip, null);
        return true;
    }

    public Task ArchiveAsync(IReadOnlyList<ThreadRow> rows) =>
        MoveLikeAsync(rows, "Archived", FolderByRole("archive"), (f, u) => _api.BatchArchiveAsync(f, u));

    public Task DeleteAsync(IReadOnlyList<ThreadRow> rows) =>
        MoveLikeAsync(rows, "Moved to Trash", FolderByRole("trash"), (f, u) => _api.BatchDeleteAsync(f, u));

    public Task JunkAsync(IReadOnlyList<ThreadRow> rows) =>
        MoveLikeAsync(rows, "Moved to Junk", FolderByRole("junk"), (f, u) => _api.BatchSpamAsync(f, u));

    public Task MoveToAsync(IReadOnlyList<ThreadRow> rows, string destination) =>
        MoveLikeAsync(rows, $"Moved to {Folders.FirstOrDefault(f => f.Path == destination)?.Name ?? destination}", destination, (f, u) => _api.BatchMoveAsync(f, u, destination));

    private async Task MoveLikeAsync(IReadOnlyList<ThreadRow> rows, string message, string? destination, Func<string, IReadOnlyCollection<long>, Task<ApiBatchResult>> call)
    {
        if (rows.Count == 0 || Blocked()) return;
        var snapshot = rows.Select(r => (Row: r, Index: Threads.IndexOf(r))).Where(x => x.Index >= 0).OrderBy(x => x.Index).ToList();
        var openWasAffected = SelectedThread is not null && rows.Contains(SelectedThread);
        foreach (var (r, _) in snapshot) Threads.Remove(r);
        if (openWasAffected) { SelectedThread = null; OpenMessages.Clear(); }
        IsEmpty = Threads.Count == 0;
        var unreadMoved = snapshot.Count(x => x.Row.Unread);
        if (unreadMoved > 0) AdjustUnseen(-unreadMoved);
        try
        {
            foreach (var g in rows.GroupBy(r => r.Folder))
            {
                var result = await call(g.Key, g.SelectMany(r => r.Uids).Distinct().ToList());
                if (!result.Ok && (result.Succeeded?.Count ?? 0) == 0) throw new ApiRequestError("The server refused the change.", 0);
            }
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            foreach (var (r, i) in snapshot) Threads.Insert(Math.Min(i, Threads.Count), r);
            IsEmpty = Threads.Count == 0;
            if (unreadMoved > 0) AdjustUnseen(+unreadMoved);
            if (e is ApiTransportError) Offline = true;
            Notice?.Invoke(e is ApiTransportError ? OfflineTip : "Could not complete that. Nothing was changed.", null);
            return;
        }
        OnPropertyChanged(nameof(HasMore));
        Func<Task>? undo = destination is null ? null : async () =>
        {
            try
            {
                foreach (var (r, _) in snapshot)
                {
                    var found = await _api.ResolveAsync(r.Model.Latest.MessageId, destination);
                    await _api.BatchMoveAsync(destination, new[] { found.Uid }, r.Folder);
                }
            }
            catch (Exception e) when (e is ApiRequestError or ApiTransportError) { Notice?.Invoke("Could not undo that", null); }
            await ReconcileAsync();
        };
        Notice?.Invoke(message, undo);
    }

    /// <summary>Toggles the star for the selection: if every row is starred it clears them, otherwise it stars all.</summary>
    public async Task ToggleFlagAsync(IReadOnlyList<ThreadRow> rows)
    {
        if (rows.Count == 0 || Blocked()) return;
        var target = !rows.All(r => r.Flagged);
        var before = rows.Select(r => (r, r.Flagged)).ToList();
        foreach (var r in rows) r.Flagged = target;
        if (!await TryFlags(rows, flagged: target)) { foreach (var (r, was) in before) r.Flagged = was; return; }
        Notice?.Invoke(target ? "Starred" : "Star removed", async () =>
        {
            foreach (var (r, was) in before) r.Flagged = was;
            await TryFlags(rows, flagged: !target);
        });
    }

    /// <summary>Marks the rows read or unread, keeping the folder's unseen count in step.</summary>
    public async Task SetReadAsync(IReadOnlyList<ThreadRow> rows, bool read)
    {
        if (rows.Count == 0 || Blocked()) return;
        var changing = rows.Where(r => r.Unread == read).ToList();
        if (changing.Count == 0) return;
        foreach (var r in changing) r.Unread = !read;
        AdjustUnseen(read ? -changing.Count : +changing.Count);
        if (!await TryFlags(changing, seen: read))
        {
            foreach (var r in changing) r.Unread = read;
            AdjustUnseen(read ? +changing.Count : -changing.Count);
        }
    }

    private async Task<bool> TryFlags(IReadOnlyList<ThreadRow> rows, bool? seen = null, bool? flagged = null)
    {
        try
        {
            foreach (var g in rows.GroupBy(r => r.Folder))
                await _api.BatchFlagsAsync(g.Key, g.SelectMany(r => r.Uids).Distinct().ToList(), seen, flagged);
            return true;
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError)
        {
            if (e is ApiTransportError) Offline = true;
            Notice?.Invoke(e is ApiTransportError ? OfflineTip : "Could not complete that. Nothing was changed.", null);
            return false;
        }
    }

    // ---- reader navigation: "N of M" ----

    public int OpenIndex => SelectedThread is null ? 0 : Threads.IndexOf(SelectedThread) + 1;
    public string OpenPosition => SelectedThread is null || Threads.Count == 0 ? "" : $"{OpenIndex} of {Total}";

    public ThreadRow? Neighbour(int delta)
    {
        if (SelectedThread is null) return null;
        var i = Threads.IndexOf(SelectedThread) + delta;
        return i >= 0 && i < Threads.Count ? Threads[i] : null;
    }
}
