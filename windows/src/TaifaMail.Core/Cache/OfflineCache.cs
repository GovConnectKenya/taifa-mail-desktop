using Microsoft.Data.Sqlite;
using System.Text.Json;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.Cache;

/// <summary>
/// Per mailbox cache of folders and thread list pages so the app can paint the inbox
/// before the network answers and keep working offline. Cleared on sign out.
/// All access is synchronous and short; callers run it off the UI thread.
/// </summary>
public sealed class OfflineCache : IDisposable
{
    private SqliteConnection _db = null!;
    private readonly object _gate = new();
    private readonly string _path;
    private long _generation;
    /// <summary>Bumped by <see cref="Wipe"/>. A save that began before a wipe passes the old value and is dropped.</summary>
    public long Generation => Interlocked.Read(ref _generation);
    private readonly ICacheProtector? _protector;

    public OfflineCache(string path, ICacheProtector? protector = null)
    {
        _path = path;
        _protector = protector;
        Open();
    }

    /// <summary>Stored JSON is protected when a protector is supplied (DPAPI, current user): the file alone reveals no mail.</summary>
    private string Seal(string json) => _protector is null ? json : "enc:" + Convert.ToBase64String(_protector.Protect(System.Text.Encoding.UTF8.GetBytes(json)));

    private string? Unseal(string stored)
    {
        if (!stored.StartsWith("enc:", StringComparison.Ordinal)) return _protector is null ? stored : null;
        if (_protector is null) return null;
        try { return System.Text.Encoding.UTF8.GetString(_protector.Unprotect(Convert.FromBase64String(stored[4..]))); }
        catch (Exception) { return null; }
    }

    /// <summary>Opens the cache; a corrupt or foreign file is deleted and recreated instead of crashing the app.</summary>
    public static OfflineCache OpenOrRecreate(string path, ICacheProtector? protector = null)
    {
        try { return new OfflineCache(path, protector); }
        catch (Exception)
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) { try { if (File.Exists(f)) File.Delete(f); } catch (IOException) { } }
            return new OfflineCache(path, protector);
        }
    }

    private void Open()
    {
        if (_path != ":memory:") Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        _db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = _path, Pooling = false }.ToString());
        _db.Open();
        Exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        Exec(@"CREATE TABLE IF NOT EXISTS folders(mailbox TEXT NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(mailbox));
               CREATE TABLE IF NOT EXISTS threads(mailbox TEXT NOT NULL, folder TEXT NOT NULL, pos INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(mailbox, folder, pos));
               CREATE TABLE IF NOT EXISTS bodies(mailbox TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(mailbox, folder, uid));
               CREATE TABLE IF NOT EXISTS meta(mailbox TEXT NOT NULL, folder TEXT NOT NULL, total INTEGER NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(mailbox, folder));");
    }

    private void Exec(string sql)
    {
        using var c = _db.CreateCommand();
        c.CommandText = sql;
        c.ExecuteNonQuery();
    }

    public void SaveFolders(string mailbox, IReadOnlyList<ApiFolder> folders, long? generation = null)
    {
        lock (_gate)
        {
            if (generation is { } g0 && g0 != Generation) return;
            using var c = _db.CreateCommand();
            c.CommandText = "INSERT OR REPLACE INTO folders(mailbox,json,saved_at) VALUES($m,$j,$t)";
            c.Parameters.AddWithValue("$m", mailbox);
            c.Parameters.AddWithValue("$j", Seal(JsonSerializer.Serialize(folders, TaifaJson.Options)));
            c.Parameters.AddWithValue("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            c.ExecuteNonQuery();
        }
    }

    public List<ApiFolder>? LoadFolders(string mailbox)
    {
        lock (_gate)
        {
            using var c = _db.CreateCommand();
            c.CommandText = "SELECT json FROM folders WHERE mailbox=$m";
            c.Parameters.AddWithValue("$m", mailbox);
            return c.ExecuteScalar() is string s && Unseal(s) is { } json ? JsonSerializer.Deserialize<List<ApiFolder>>(json, TaifaJson.Options) : null;
        }
    }

    /// <summary>Replaces the cached first page of a folder (kept small: only what the next cold start paints).</summary>
    public void SaveThreads(string mailbox, string folder, IReadOnlyList<ApiConversationSummary> items, int total, int keep = 100, long? generation = null)
    {
        lock (_gate)
        {
            if (generation is { } g1 && g1 != Generation) return;
            using var tx = _db.BeginTransaction();
            using (var del = _db.CreateCommand())
            {
                del.Transaction = tx;
                del.CommandText = "DELETE FROM threads WHERE mailbox=$m AND folder=$f";
                del.Parameters.AddWithValue("$m", mailbox);
                del.Parameters.AddWithValue("$f", folder);
                del.ExecuteNonQuery();
            }
            var pos = 0;
            foreach (var it in items.Take(keep))
            {
                using var ins = _db.CreateCommand();
                ins.Transaction = tx;
                ins.CommandText = "INSERT INTO threads(mailbox,folder,pos,json) VALUES($m,$f,$p,$j)";
                ins.Parameters.AddWithValue("$m", mailbox);
                ins.Parameters.AddWithValue("$f", folder);
                ins.Parameters.AddWithValue("$p", pos++);
                ins.Parameters.AddWithValue("$j", Seal(JsonSerializer.Serialize(it, TaifaJson.Options)));
                ins.ExecuteNonQuery();
            }
            using (var meta = _db.CreateCommand())
            {
                meta.Transaction = tx;
                meta.CommandText = "INSERT OR REPLACE INTO meta(mailbox,folder,total,saved_at) VALUES($m,$f,$t,$s)";
                meta.Parameters.AddWithValue("$m", mailbox);
                meta.Parameters.AddWithValue("$f", folder);
                meta.Parameters.AddWithValue("$t", total);
                meta.Parameters.AddWithValue("$s", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                meta.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    public (List<ApiConversationSummary> Items, int Total)? LoadThreads(string mailbox, string folder)
    {
        lock (_gate)
        {
            var items = new List<ApiConversationSummary>();
            using (var c = _db.CreateCommand())
            {
                c.CommandText = "SELECT json FROM threads WHERE mailbox=$m AND folder=$f ORDER BY pos";
                c.Parameters.AddWithValue("$m", mailbox);
                c.Parameters.AddWithValue("$f", folder);
                using var r = c.ExecuteReader();
                while (r.Read()) { if (Unseal(r.GetString(0)) is { } json) items.Add(JsonSerializer.Deserialize<ApiConversationSummary>(json, TaifaJson.Options)!); }
            }
            if (items.Count == 0) return null;
            using var m = _db.CreateCommand();
            m.CommandText = "SELECT total FROM meta WHERE mailbox=$m AND folder=$f";
            m.Parameters.AddWithValue("$m", mailbox);
            m.Parameters.AddWithValue("$f", folder);
            var total = m.ExecuteScalar() is long l ? (int)l : items.Count;
            return (items, total);
        }
    }

    /// <summary>Stores an opened conversation so it can be read offline. Keeps the newest few hundred.</summary>
    public void SaveConversation(string mailbox, string folder, long uid, ApiConversationWindow window, int keep = 300, long? generation = null)
    {
        lock (_gate)
        {
            if (generation is { } g2 && g2 != Generation) return;
            using (var c = _db.CreateCommand())
            {
                c.CommandText = "INSERT OR REPLACE INTO bodies(mailbox,folder,uid,json,saved_at) VALUES($m,$f,$u,$j,$t)";
                c.Parameters.AddWithValue("$m", mailbox);
                c.Parameters.AddWithValue("$f", folder);
                c.Parameters.AddWithValue("$u", uid);
                c.Parameters.AddWithValue("$j", Seal(JsonSerializer.Serialize(window, TaifaJson.Options)));
                c.Parameters.AddWithValue("$t", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                c.ExecuteNonQuery();
            }
            using var prune = _db.CreateCommand();
            prune.CommandText = "DELETE FROM bodies WHERE mailbox=$m AND rowid NOT IN (SELECT rowid FROM bodies WHERE mailbox=$m ORDER BY saved_at DESC LIMIT $k)";
            prune.Parameters.AddWithValue("$m", mailbox);
            prune.Parameters.AddWithValue("$k", keep);
            prune.ExecuteNonQuery();
        }
    }

    public ApiConversationWindow? LoadConversation(string mailbox, string folder, long uid)
    {
        lock (_gate)
        {
            using var c = _db.CreateCommand();
            c.CommandText = "SELECT json FROM bodies WHERE mailbox=$m AND folder=$f AND uid=$u";
            c.Parameters.AddWithValue("$m", mailbox);
            c.Parameters.AddWithValue("$f", folder);
            c.Parameters.AddWithValue("$u", uid);
            return c.ExecuteScalar() is string s && Unseal(s) is { } json ? JsonSerializer.Deserialize<ApiConversationWindow>(json, TaifaJson.Options) : null;
        }
    }

    /// <summary>Drops everything. Called on sign out so no mail outlives the session.</summary>
    public void Clear()
    {
        lock (_gate) Exec("DELETE FROM folders; DELETE FROM threads; DELETE FROM meta; DELETE FROM bodies;");
    }

    /// <summary>Sign out: closes the connection and deletes the database with its -wal and -shm files, then starts a fresh empty one.</summary>
    public void Wipe()
    {
        lock (_gate)
        {
            Interlocked.Increment(ref _generation);
            if (_path == ":memory:") { Exec("DELETE FROM folders; DELETE FROM threads; DELETE FROM meta; DELETE FROM bodies;"); return; }
            _db.Dispose();
            SqliteConnection.ClearAllPools();
            foreach (var f in new[] { _path, _path + "-wal", _path + "-shm" })
            {
                try { if (File.Exists(f)) File.Delete(f); } catch (IOException) { }
            }
            Open();
        }
    }

    public void Dispose() => _db.Dispose();
}

/// <summary>Protects cached JSON at rest.</summary>
public interface ICacheProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>DPAPI, current user scope: only this Windows account can read the cache.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DpapiCacheProtector : ICacheProtector
{
    private static readonly byte[] Entropy = System.Text.Encoding.UTF8.GetBytes("taifa-mail-windows-cache-v1");
    public byte[] Protect(byte[] data) => System.Security.Cryptography.ProtectedData.Protect(data, Entropy, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] data) => System.Security.Cryptography.ProtectedData.Unprotect(data, Entropy, System.Security.Cryptography.DataProtectionScope.CurrentUser);
}
