using TaifaMail.Core.Models;

namespace TaifaMail.Core.Net;

public sealed class AuthApi : IAuthApi
{
    private readonly TaifaApiClient _api;
    public AuthApi(TaifaApiClient api) => _api = api;

    public async Task<LoginResult> LoginAsync(string address, string password, CancellationToken ct = default) =>
        ToResult(await _api.PostAsync<RawLogin>("/auth/mailbox-login", new { address = address.Trim().ToLowerInvariant(), password }, ct));

    /// <summary>Asks the server to email a six digit code to the owner's recovery address. The reply is generic by design.</summary>
    public Task RequestLoginCodeAsync(string address, CancellationToken ct = default) =>
        _api.PostAsync("/auth/mailbox-login-code/request", new { address = address.Trim().ToLowerInvariant() }, ct);

    public async Task<LoginResult> VerifyLoginCodeAsync(string address, string code, CancellationToken ct = default) =>
        ToResult(await _api.PostAsync<RawLogin>("/auth/mailbox-login-code/verify", new { address = address.Trim().ToLowerInvariant(), code = code.Trim() }, ct));

    public async Task<LoginResult> VerifySecondFactorAsync(string code, CancellationToken ct = default) =>
        ToResult(await _api.PostAsync<RawLogin>("/auth/mailbox-2fa/verify", new { code = code.Trim() }, ct));

    /// <summary>Emails a one-time second factor code as the fallback to the authenticator app.</summary>
    public Task ChallengeSecondFactorAsync(CancellationToken ct = default) => _api.PostAsync("/auth/mailbox-2fa/challenge", null, ct);

    public Task<MailboxMe> MeAsync(CancellationToken ct = default) => _api.GetAsync<MailboxMe>("/auth/mailbox/me", ct);

    public Task<List<SwitchableMailbox>> SwitchableAsync(CancellationToken ct = default) => _api.GetAsync<List<SwitchableMailbox>>("/auth/mailbox/switchable", ct);

    public Task SwitchAsync(string mailboxId, CancellationToken ct = default) => _api.PostAsync("/auth/mailbox/switch", new { mailbox_id = mailboxId }, ct);

    /// <summary>Revokes the session on the server, then drops the local cookies whatever the server said.</summary>
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        try { await _api.PostAsync("/auth/mailbox/logout", null, ct).ConfigureAwait(false); }
        catch (ApiTransportError) { }
        catch (ApiRequestError) { }
        finally { _api.ClearSession(); }
    }

    private static LoginResult ToResult(RawLogin raw)
    {
        if (raw.Requires2Fa == true) return LoginResult.NeedsSecondFactor(raw.Address ?? "");
        if (raw.MailboxId is null || raw.Address is null) throw new ApiRequestError("Taifa Mail returned an unexpected sign in reply.", 502);
        return LoginResult.Signed(new MailboxSession(raw.MailboxId, raw.Address, raw.OrgId));
    }
}
