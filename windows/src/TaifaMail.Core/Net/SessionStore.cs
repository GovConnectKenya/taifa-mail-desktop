using System.Security.Cryptography;
using System.Text;

namespace TaifaMail.Core.Net;

/// <summary>Where the serialized cookie jar lives between runs.</summary>
public interface ISessionStore
{
    string? Load();
    void Save(string payload);
    void Clear();
}

public sealed class MemorySessionStore : ISessionStore
{
    private string? _value;
    public string? Load() => _value;
    public void Save(string payload) => _value = payload;
    public void Clear() => _value = null;
}

/// <summary>
/// Cookie jar encrypted with DPAPI (current user scope) in an app-private file.
/// The cookies are the only secret the app holds; no password is ever stored.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DpapiSessionStore : ISessionStore
{
    private readonly string _path;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("taifa-mail-windows-session-v1");

    public DpapiSessionStore(string path) => _path = path;

    public string? Load()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var blob = File.ReadAllBytes(_path);
            var plain = ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception)
        {
            // A corrupt or foreign-user file is the same as no session.
            return null;
        }
    }

    public void Save(string payload)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(payload), Entropy, DataProtectionScope.CurrentUser);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, blob);
        File.Move(tmp, _path, overwrite: true);
    }

    public void Clear()
    {
        try { if (File.Exists(_path)) File.Delete(_path); } catch (IOException) { }
    }
}
