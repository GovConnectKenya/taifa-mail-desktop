using System.Collections.Concurrent;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Media.Imaging;
using TaifaMail.Core.Net;
using Windows.Storage.Streams;

namespace TaifaMail.App.Services;

/// <summary>
/// Avatar and logo pictures: memory cache over a disk cache over the network. Bytes are fetched and written off
/// the UI thread; only the final BitmapImage is created on it, with decode size capped at 2x the display size.
/// </summary>
public sealed class ImageCache
{
    public static ImageCache? Instance { get; set; }

    private readonly TaifaApiClient _api;
    private readonly string _dir;
    private readonly DispatcherQueue _ui;
    private readonly ConcurrentDictionary<string, Task<byte[]?>> _bytes = new();
    private readonly object _lruGate = new();
    private readonly LinkedList<string> _lru = new();
    private readonly Dictionary<string, BitmapImage> _images = new();
    private const int MaxImages = 400;

    public ImageCache(TaifaApiClient api, string dir, DispatcherQueue ui)
    {
        _api = api;
        _dir = dir;
        _ui = ui;
        Directory.CreateDirectory(dir);
    }

    private readonly Queue<string> _byteOrder = new();
    private const int MaxByteTasks = 300;

    /// <summary>Completed byte tasks are evicted oldest first so the dictionary cannot grow without bound.</summary>
    private void TrackBytes(string url)
    {
        lock (_lruGate)
        {
            _byteOrder.Enqueue(url);
            while (_byteOrder.Count > MaxByteTasks) _bytes.TryRemove(_byteOrder.Dequeue(), out _);
        }
    }

    private static string Key(string url, int px) => url + "|" + px;
    private string FilePath(string url)
    {
        var name = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(url)));
        return Path.Combine(_dir, name + ".img");
    }

    /// <summary>Returns a decoded image for the url, or null when it cannot be fetched. Call from the UI thread.</summary>
    public async Task<BitmapImage?> GetAsync(string url, int displayPx)
    {
        var decode = Math.Max(16, displayPx * 2);
        var key = Key(url, decode);
        lock (_lruGate)
        {
            if (_images.TryGetValue(key, out var hit))
            {
                _lru.Remove(key);
                _lru.AddFirst(key);
                return hit;
            }
        }
        var data = await _bytes.GetOrAdd(url, u => { TrackBytes(u); return Task.Run(() => LoadBytesAsync(u)); });
        if (data is null) { _bytes.TryRemove(url, out _); return null; }
        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(data.AsBuffer());
        stream.Seek(0);
        var bmp = new BitmapImage { DecodePixelWidth = decode, DecodePixelType = DecodePixelType.Logical };
        await bmp.SetSourceAsync(stream);
        lock (_lruGate)
        {
            _images[key] = bmp;
            _lru.AddFirst(key);
            while (_lru.Count > MaxImages) { _images.Remove(_lru.Last!.Value); _lru.RemoveLast(); }
        }
        return bmp;
    }

    private async Task<byte[]?> LoadBytesAsync(string url)
    {
        var path = FilePath(url);
        try { if (File.Exists(path)) return await File.ReadAllBytesAsync(path); } catch (IOException) { }
        var data = await _api.TryGetBytesAsync(url);
        if (data is { Length: > 0 })
        {
            try { await File.WriteAllBytesAsync(path, data); } catch (IOException) { }
        }
        return data;
    }

    /// <summary>Forgets everything. Called on sign out so no picture outlives the session.</summary>
    public void Clear()
    {
        _bytes.Clear();
        lock (_lruGate) _byteOrder.Clear();
        lock (_lruGate) { _images.Clear(); _lru.Clear(); }
        try { foreach (var f in Directory.EnumerateFiles(_dir, "*.img")) File.Delete(f); } catch (IOException) { }
    }
}
