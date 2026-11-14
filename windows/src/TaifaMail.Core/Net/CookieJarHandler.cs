using System.Net;
using System.Text.Json;

namespace TaifaMail.Core.Net;

/// <summary>
/// Cookie handling done in the message pipeline so it behaves the same over any
/// inner handler (real sockets, or a fake in tests). Persists to an
/// <see cref="ISessionStore"/> whenever the server changes a cookie.
/// </summary>
public sealed class CookieJarHandler : DelegatingHandler
{
    private readonly CookieContainer _jar = new();
    private readonly ISessionStore _store;
    private readonly Uri _origin;
    private readonly object _gate = new();

    public CookieJarHandler(HttpMessageHandler inner, ISessionStore store, Uri origin) : base(inner)
    {
        _store = store;
        _origin = origin;
        Restore();
    }

    public string? CookieValue(string name)
    {
        lock (_gate) return _jar.GetCookies(_origin).Cast<Cookie>().FirstOrDefault(c => c.Name == name && !c.Expired)?.Value;
    }

    public bool HasSessionCookie => CookieValue("tfm_mb_refresh") != null || CookieValue("tfm_mb_access") != null;

    public string CookieHeader()
    {
        lock (_gate) return _jar.GetCookieHeader(_origin);
    }

    public void Clear()
    {
        lock (_gate)
        {
            foreach (Cookie c in _jar.GetCookies(_origin)) c.Expired = true;
        }
        _store.Clear();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        string header;
        lock (_gate) header = _jar.GetCookieHeader(request.RequestUri ?? _origin);
        if (header.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", header);

        var response = await base.SendAsync(request, ct).ConfigureAwait(false);

        if (response.Headers.TryGetValues("Set-Cookie", out var values))
        {
            lock (_gate)
            {
                foreach (var v in values)
                {
                    try { _jar.SetCookies(request.RequestUri ?? _origin, v); } catch (CookieException) { }
                }
            }
            Persist();
        }
        return response;
    }

    private sealed record Stored(string Name, string Value, string Domain, string Path, DateTime? Expires, bool Secure, bool HttpOnly);

    private void Persist()
    {
        List<Stored> items;
        lock (_gate)
        {
            items = _jar.GetCookies(_origin).Cast<Cookie>()
                .Where(c => !c.Expired)
                .Select(c => new Stored(c.Name, c.Value, c.Domain, c.Path, c.Expires == DateTime.MinValue ? null : c.Expires.ToUniversalTime(), c.Secure, c.HttpOnly))
                .ToList();
        }
        if (items.Count == 0) { _store.Clear(); return; }
        _store.Save(JsonSerializer.Serialize(items));
    }

    private void Restore()
    {
        var raw = _store.Load();
        if (string.IsNullOrEmpty(raw)) return;
        try
        {
            var items = JsonSerializer.Deserialize<List<Stored>>(raw) ?? new();
            lock (_gate)
            {
                foreach (var s in items)
                {
                    var c = new Cookie(s.Name, s.Value, s.Path, s.Domain) { Secure = s.Secure, HttpOnly = s.HttpOnly };
                    if (s.Expires is { } e) c.Expires = e;
                    if (!c.Expired) _jar.Add(c);
                }
            }
        }
        catch (JsonException) { _store.Clear(); }
    }
}
