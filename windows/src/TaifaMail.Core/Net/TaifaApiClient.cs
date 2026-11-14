using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using TaifaMail.Core.Models;

namespace TaifaMail.Core.Net;

/// <summary>
/// HTTP core for the Taifa Mail API. Mirrors the mobile client: cookie session,
/// CSRF double submit (tfm_csrf cookie echoed as X-CSRF-Token), one silent
/// refresh on 401, one CSRF re-issue on 403 csrf_invalid.
/// </summary>
public sealed class TaifaApiClient : IDisposable
{
    public const string ProductionBase = "https://mail.govconnect.ke";

    private readonly HttpClient _http;
    private readonly CookieJarHandler _jar;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private string _csrf = "";

    public Uri BaseUri { get; }
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Raised once when a refresh fails: the session is over and the UI must show sign in.</summary>
    public event Action? SessionExpired;

    public TaifaApiClient(string? baseUrl = null, ISessionStore? store = null, HttpMessageHandler? inner = null)
    {
        BaseUri = new Uri((baseUrl ?? ProductionBase).TrimEnd('/') + "/");
        inner ??= new SocketsHttpHandler
        {
            UseCookies = false,
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        _jar = new CookieJarHandler(inner, store ?? new MemorySessionStore(), BaseUri);
        _http = new HttpClient(_jar) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("TaifaMailWindows", "1.0"));
        _csrf = _jar.CookieValue("tfm_csrf") ?? "";
    }

    public bool HasStoredSession => _jar.HasSessionCookie;
    public string CookieHeader() => _jar.CookieHeader();
    public string AbsoluteUrl(string pathOrUrl) => pathOrUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? pathOrUrl : new Uri(BaseUri, pathOrUrl.TrimStart('/')).ToString();

    public void ClearSession()
    {
        _csrf = "";
        _jar.Clear();
    }

    private async Task<string> EnsureCsrfAsync(CancellationToken ct, bool fresh = false)
    {
        if (!fresh)
        {
            if (_csrf.Length > 0) return _csrf;
            var cookie = _jar.CookieValue("tfm_csrf");
            if (!string.IsNullOrEmpty(cookie)) return _csrf = cookie;
        }
        using var req = new HttpRequestMessage(HttpMethod.Get, new Uri(BaseUri, "auth/csrf"));
        using var res = await SendRawAsync(req, ct).ConfigureAwait(false);
        string? token = null;
        try
        {
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            if (doc.RootElement.TryGetProperty("csrf_token", out var t)) token = t.GetString();
        }
        catch (JsonException) { }
        token ??= res.Headers.TryGetValues("X-CSRF-Token", out var h) ? h.FirstOrDefault() : null;
        token ??= _jar.CookieValue("tfm_csrf");
        if (string.IsNullOrEmpty(token)) throw new ApiRequestError("Taifa Mail could not establish a secure session.", (int)res.StatusCode);
        return _csrf = token;
    }

    private async Task<HttpResponseMessage> SendRawAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(Timeout);
        try
        {
            return await _http.SendAsync(req, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ApiTransportError("Taifa Mail did not answer in time.");
        }
        catch (HttpRequestException e)
        {
            throw new ApiTransportError("Taifa Mail could not reach the server.", e);
        }
    }

    /// <summary>Sends a JSON request and returns the raw response body text (empty for 204).</summary>
    public async Task<string> SendJsonAsync(HttpMethod method, string path, object? body = null, CancellationToken ct = default)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(method, new Uri(BaseUri, path.TrimStart('/')));
            req.Headers.Accept.ParseAdd("application/json");
            if (body != null) req.Content = new StringContent(JsonSerializer.Serialize(body, TaifaJson.Options), Encoding.UTF8, "application/json");
            if (method != HttpMethod.Get && method != HttpMethod.Head)
                req.Headers.TryAddWithoutValidation("X-CSRF-Token", await EnsureCsrfAsync(ct).ConfigureAwait(false));

            using var res = await SendRawAsync(req, ct).ConfigureAwait(false);
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            TrackCsrf();

            if (res.StatusCode == HttpStatusCode.Forbidden && attempt == 0 && ErrorCode(text) == "csrf_invalid")
            {
                _csrf = "";
                await EnsureCsrfAsync(ct, fresh: true).ConfigureAwait(false);
                continue;
            }
            if (res.StatusCode == HttpStatusCode.Unauthorized && attempt == 0 && !IsLoginPath(path))
            {
                switch (await RefreshSharedAsync(ct).ConfigureAwait(false))
                {
                    case RefreshOutcome.Renewed: continue;
                    case RefreshOutcome.Rejected: SessionExpired?.Invoke(); break;
                    default: throw new ApiTransportError("Taifa Mail is not answering right now. Your session is kept; try again shortly.");
                }
            }
            if ((int)res.StatusCode is >= 300 and < 400) throw new ApiRequestError("Taifa Mail answered with an unexpected redirect.", (int)res.StatusCode, "redirect");
            if (!res.IsSuccessStatusCode) throw ToError(res.StatusCode, text);
            return text;
        }
    }

    private static bool IsLoginPath(string p) =>
        p.StartsWith("/auth/mailbox-login", StringComparison.Ordinal) || p.StartsWith("auth/mailbox-login", StringComparison.Ordinal) ||
        p.Contains("mailbox-2fa/", StringComparison.Ordinal);

    private void TrackCsrf()
    {
        var c = _jar.CookieValue("tfm_csrf");
        if (!string.IsNullOrEmpty(c)) _csrf = c;
    }

    public enum RefreshOutcome { Renewed, Rejected, Transient }

    private Task<RefreshOutcome>? _refreshTask;
    private readonly object _refreshLock = new();

    /// <summary>All concurrent 401s share one in flight refresh. Only 401 or 403 from the refresh ends the session.</summary>
    private Task<RefreshOutcome> RefreshSharedAsync(CancellationToken ct)
    {
        lock (_refreshLock)
        {
            return _refreshTask is { IsCompleted: false } running ? running : _refreshTask = RefreshAsync(CancellationToken.None);
        }
    }

    public static RefreshOutcome Classify(HttpStatusCode status) =>
        status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ? RefreshOutcome.Rejected
        : (int)status is >= 200 and < 300 ? RefreshOutcome.Renewed
        : RefreshOutcome.Transient;

    private async Task<RefreshOutcome> RefreshAsync(CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(BaseUri, "auth/mailbox/refresh"));
            req.Headers.Accept.ParseAdd("application/json");
            req.Headers.TryAddWithoutValidation("X-CSRF-Token", await EnsureCsrfAsync(ct).ConfigureAwait(false));
            using var res = await SendRawAsync(req, ct).ConfigureAwait(false);
            TrackCsrf();
            return Classify(res.StatusCode);
        }
        catch (ApiTransportError) { return RefreshOutcome.Transient; }
        catch (ApiRequestError) { return RefreshOutcome.Transient; }
    }

    public async Task<T> GetAsync<T>(string path, CancellationToken ct = default) =>
        Decode<T>(await SendJsonAsync(HttpMethod.Get, path, null, ct).ConfigureAwait(false));

    public async Task<T> PostAsync<T>(string path, object? body = null, CancellationToken ct = default) =>
        Decode<T>(await SendJsonAsync(HttpMethod.Post, path, body ?? new { }, ct).ConfigureAwait(false));

    public Task PostAsync(string path, object? body = null, CancellationToken ct = default) =>
        SendJsonAsync(HttpMethod.Post, path, body ?? new { }, ct);

    public async Task<T> PutAsync<T>(string path, object body, CancellationToken ct = default) =>
        Decode<T>(await SendJsonAsync(HttpMethod.Put, path, body, ct).ConfigureAwait(false));

    public Task DeleteAsync(string path, CancellationToken ct = default) => SendJsonAsync(HttpMethod.Delete, path, null, ct);

    /// <summary>Streams a binary download (attachments) to a stream; authenticated by the cookie jar.</summary>
    public async Task DownloadAsync(string pathOrUrl, Stream destination, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, AbsoluteUrl(pathOrUrl));
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromMinutes(5));
        HttpResponseMessage res;
        try { res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new ApiTransportError("Taifa Mail could not reach the server.", e); }
        using (res)
        {
            if (!res.IsSuccessStatusCode) throw ToError(res.StatusCode, await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            await res.Content.CopyToAsync(destination, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Uploads to an object storage presigned URL with exactly the headers it named: no CSRF header, no extra headers.</summary>
    public async Task PutPresignedAsync(ApiUploadTarget target, Stream content, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(new HttpMethod(string.IsNullOrEmpty(target.Method) ? "PUT" : target.Method), target.Url);
        req.Content = new StreamContent(content);
        if (target.Headers is not null)
            foreach (var (k, v) in target.Headers)
                if (!req.Content.Headers.TryAddWithoutValidation(k, v)) req.Headers.TryAddWithoutValidation(k, v);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromMinutes(10));
        try
        {
            using var res = await _http.SendAsync(req, cts.Token).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode) throw new ApiRequestError("The attachment could not be uploaded.", (int)res.StatusCode);
        }
        catch (HttpRequestException e) { throw new ApiTransportError("Taifa Mail could not reach the server.", e); }
    }

    /// <summary>Fetches an image or other small resource (avatars) as bytes. Returns null on any non-success.</summary>
    public async Task<byte[]?> TryGetBytesAsync(string pathOrUrl, CancellationToken ct = default)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, AbsoluteUrl(pathOrUrl));
            using var res = await SendRawAsync(req, ct).ConfigureAwait(false);
            return res.IsSuccessStatusCode ? await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false) : null;
        }
        catch (ApiTransportError) { return null; }
    }

    private static T Decode<T>(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return default!;
        try { return JsonSerializer.Deserialize<T>(text, TaifaJson.Options)!; }
        catch (JsonException e) { throw new ApiRequestError("Taifa Mail sent a reply this version cannot read.", 502, "bad_reply") { }.WithInner(e); }
    }

    private static string? ErrorCode(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.Object && d.TryGetProperty("code", out var c))
                return c.GetString();
        }
        catch (JsonException) { }
        return null;
    }

    public static ApiRequestError ToError(HttpStatusCode status, string body)
    {
        string? message = null, code = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("detail", out var d))
            {
                if (d.ValueKind == JsonValueKind.String) message = d.GetString();
                else if (d.ValueKind == JsonValueKind.Object)
                {
                    if (d.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) message = m.GetString();
                    if (d.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = c.GetString();
                }
            }
        }
        catch (JsonException) { }
        return new ApiRequestError(message ?? "Taifa Mail could not complete the request.", (int)status, code);
    }

    public void Dispose() { _http.Dispose(); _refreshGate.Dispose(); }
}
