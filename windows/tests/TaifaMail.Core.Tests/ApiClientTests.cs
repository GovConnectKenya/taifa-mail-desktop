using System.Net;
using TaifaMail.Core.Net;
using static TaifaMail.Core.Tests.FakeHandler;

namespace TaifaMail.Core.Tests;

public class ApiClientTests
{
    private static TaifaApiClient Client(HttpMessageHandler h, ISessionStore? store = null) => new("https://mail.example.test", store, h);

    [Fact]
    public async Task Post_fetches_csrf_first_and_echoes_it()
    {
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"ok\":true,\"csrf_token\":\"tok1\"}", "tfm_csrf=tok1; Path=/"))
            .On("POST /auth/mailbox-login", _ => Json(HttpStatusCode.OK, "{\"mailbox_id\":\"m1\",\"address\":\"a@example.test\",\"org_id\":null}", "tfm_mb_access=A; Path=/", "tfm_mb_refresh=R; Path=/"));
        using var api = Client(h);
        var r = await new AuthApi(api).LoginAsync("A@Example.test ", "pw");
        Assert.NotNull(r.Session);
        Assert.Equal("m1", r.Session!.MailboxId);
        Assert.Equal("tok1", h.Requests.Last().Csrf);
        Assert.Contains("\"address\":\"a@example.test\"", h.Requests.Last().Body);
        Assert.True(api.HasStoredSession);
    }

    [Fact]
    public async Task Csrf_invalid_403_reissues_token_and_retries_once()
    {
        var calls = 0;
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"fresh\"}", "tfm_csrf=fresh; Path=/"))
            .On("POST /v1/x", _ => ++calls == 1
                ? Json(HttpStatusCode.Forbidden, "{\"detail\":{\"code\":\"csrf_invalid\",\"message\":\"no\"}}")
                : Json(HttpStatusCode.OK, "{\"ok\":true}"));
        using var api = Client(h);
        await api.PostAsync("/v1/x", new { a = 1 });
        Assert.Equal(2, calls);
        Assert.Equal(2, h.Requests.Count(r => r.PathAndQuery == "/v1/x"));
    }

    [Fact]
    public async Task Unauthorized_triggers_one_refresh_then_retries()
    {
        var n = 0;
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}", "tfm_csrf=t; Path=/"))
            .On("GET /v1/inbox/m/folders", _ => ++n == 1 ? Json(HttpStatusCode.Unauthorized, "{\"detail\":\"expired\"}") : Json(HttpStatusCode.OK, "[]"))
            .On("POST /auth/mailbox/refresh", _ => Json(HttpStatusCode.OK, "{\"ok\":true}", "tfm_mb_access=B; Path=/"));
        using var api = Client(h);
        var folders = await new MailApi(api, "m").FoldersAsync();
        Assert.Empty(folders);
        Assert.Contains(h.Requests, r => r.PathAndQuery == "/auth/mailbox/refresh");
    }

    [Fact]
    public async Task Failed_refresh_raises_session_expired_and_throws()
    {
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("GET /v1/inbox/m/folders", _ => Json(HttpStatusCode.Unauthorized, "{\"detail\":\"expired\"}"))
            .On("POST /auth/mailbox/refresh", _ => Json(HttpStatusCode.Unauthorized, "{\"detail\":\"gone\"}"));
        using var api = Client(h);
        var expired = false;
        api.SessionExpired += () => expired = true;
        var e = await Assert.ThrowsAsync<ApiRequestError>(() => new MailApi(api, "m").FoldersAsync());
        Assert.Equal(401, e.Status);
        Assert.True(expired);
    }

    [Fact]
    public async Task Login_failure_does_not_try_to_refresh()
    {
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("POST /auth/mailbox-login", _ => Json(HttpStatusCode.Unauthorized, "{\"detail\":\"Invalid address or password\"}"));
        using var api = Client(h);
        var e = await Assert.ThrowsAsync<ApiRequestError>(() => new AuthApi(api).LoginAsync("a@b.test", "x"));
        Assert.Equal("Invalid address or password", e.Message);
        Assert.DoesNotContain(h.Requests, r => r.PathAndQuery.Contains("refresh"));
    }

    [Fact]
    public async Task Second_factor_pending_is_reported()
    {
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("POST /auth/mailbox-login", _ => Json(HttpStatusCode.OK, "{\"requires_2fa\":true,\"address\":\"a@b.test\"}"));
        using var api = Client(h);
        var r = await new AuthApi(api).LoginAsync("a@b.test", "pw");
        Assert.True(r.RequiresSecondFactor);
        Assert.Null(r.Session);
    }

    [Fact]
    public async Task Cookies_are_persisted_and_restored_and_logout_clears_them()
    {
        var store = new MemorySessionStore();
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}", "tfm_csrf=t; Path=/"))
            .On("POST /auth/mailbox-login", _ => Json(HttpStatusCode.OK, "{\"mailbox_id\":\"m\",\"address\":\"a@b.test\"}", "tfm_mb_refresh=R; Path=/; Max-Age=3600"))
            .On("POST /auth/mailbox/logout", _ => Json(HttpStatusCode.OK, "{\"ok\":true}"));
        using (var api = Client(h, store)) await new AuthApi(api).LoginAsync("a@b.test", "pw");
        Assert.NotNull(store.Load());

        using var again = Client(h, store);
        Assert.True(again.HasStoredSession);
        await new AuthApi(again).LogoutAsync();
        Assert.False(again.HasStoredSession);
        Assert.Null(store.Load());
    }

    [Fact]
    public async Task Logout_clears_local_session_even_when_offline()
    {
        var store = new MemorySessionStore();
        store.Save("[{\"Name\":\"tfm_mb_refresh\",\"Value\":\"R\",\"Domain\":\"mail.example.test\",\"Path\":\"/\",\"Expires\":null,\"Secure\":false,\"HttpOnly\":false}]");
        using var api = Client(new ThrowingHandler(), store);
        Assert.True(api.HasStoredSession);
        await new AuthApi(api).LogoutAsync();
        Assert.False(api.HasStoredSession);
    }

    [Fact]
    public void Query_builder_encodes_and_skips_nulls()
    {
        Assert.Equal("?folder=INBOX%2FSent&limit=5&flag=true", MailApi.Q(("folder", "INBOX/Sent"), ("limit", 5), ("skip", null), ("flag", true)));
    }

    [Fact]
    public async Task Detail_object_errors_expose_code()
    {
        var h = new FakeHandler()
            .On("GET /auth/csrf", _ => Json(HttpStatusCode.OK, "{\"csrf_token\":\"t\"}"))
            .On("POST /v1/inbox/m/send", _ => Json(HttpStatusCode.UnprocessableEntity, "{\"detail\":{\"code\":\"bad_recipient\",\"message\":\"Bad recipient\"}}"));
        using var api = Client(h);
        var e = await Assert.ThrowsAsync<ApiRequestError>(() => new MailApi(api, "m").SendAsync(new() { To = { "x" } }));
        Assert.Equal("bad_recipient", e.Code);
        Assert.Equal("Bad recipient", e.Message);
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => throw new HttpRequestException("offline");
    }
}
