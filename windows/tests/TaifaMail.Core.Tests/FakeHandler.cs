using System.Net;
using System.Text;

namespace TaifaMail.Core.Tests;

/// <summary>Scripted HTTP server: routes by "METHOD path" and records every request.</summary>
public sealed class FakeHandler : HttpMessageHandler
{
    public sealed record Seen(HttpMethod Method, string PathAndQuery, string? Csrf, string? Cookie, string? Body);

    public List<Seen> Requests { get; } = new();
    private readonly Dictionary<string, Queue<Func<HttpRequestMessage, HttpResponseMessage>>> _routes = new();

    public FakeHandler On(string key, Func<HttpRequestMessage, HttpResponseMessage> reply)
    {
        if (!_routes.TryGetValue(key, out var q)) _routes[key] = q = new();
        q.Enqueue(reply);
        return this;
    }

    public static HttpResponseMessage Json(HttpStatusCode code, string body, params string[] setCookies)
    {
        var r = new HttpResponseMessage(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        foreach (var c in setCookies) r.Headers.TryAddWithoutValidation("Set-Cookie", c);
        return r;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        var csrf = request.Headers.TryGetValues("X-CSRF-Token", out var v) ? v.First() : null;
        var cookie = request.Headers.TryGetValues("Cookie", out var c) ? string.Join("; ", c) : null;
        Requests.Add(new Seen(request.Method, request.RequestUri!.PathAndQuery, csrf, cookie, body));
        var key = $"{request.Method} {request.RequestUri!.AbsolutePath}";
        if (_routes.TryGetValue(key, out var q) && q.Count > 0)
        {
            var f = q.Count > 1 ? q.Dequeue() : q.Peek();
            return f(request);
        }
        return Json(HttpStatusCode.NotFound, "{\"detail\":\"no route " + key + "\"}");
    }
}
