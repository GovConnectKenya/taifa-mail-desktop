using CommunityToolkit.Mvvm.ComponentModel;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.ViewModels;

public enum SignInStep { Password, Code, SecondFactor, Done }

/// <summary>Sign in flow: address and password, or an emailed sign in code, then the second factor when the owner has one.</summary>
public sealed partial class SignInViewModel : ObservableObject
{
    private readonly IAuthApi _auth;

    public SignInViewModel(IAuthApi auth) => _auth = auth;

    [ObservableProperty, NotifyPropertyChangedFor(nameof(ShowPassword), nameof(ShowCode), nameof(ShowSecondFactor), nameof(CodeTitle))] private SignInStep _step = SignInStep.Password;
    [ObservableProperty, NotifyPropertyChangedFor(nameof(CanSubmitPassword), nameof(CanRequestCode))] private string _address = "";
    [ObservableProperty, NotifyPropertyChangedFor(nameof(CanSubmitPassword))] private string _password = "";
    [ObservableProperty] private string _code = "";
    [ObservableProperty, NotifyPropertyChangedFor(nameof(CanSubmitPassword), nameof(CanRequestCode), nameof(Idle))] private bool _busy;
    [ObservableProperty] private string? _error;
    [ObservableProperty] private string? _notice;
    [ObservableProperty] private bool _codeEmailSent;
    [ObservableProperty] private bool _offline;
    /// <summary>"Remember my address": the only thing kept after sign out, and only when ticked.</summary>
    [ObservableProperty] private bool _remember;

    public bool ShowPassword => Step == SignInStep.Password;
    public bool ShowCode => Step == SignInStep.Code;
    public bool ShowSecondFactor => Step == SignInStep.SecondFactor;
    public string CodeTitle => Step == SignInStep.SecondFactor ? "Verification code" : "Sign-in code";

    public MailboxSession? Session { get; private set; }
    public event Action<MailboxSession>? SignedIn;

    public bool Idle => !Busy;
    public bool CanSubmitPassword => !Busy && Address.Contains('@') && Password.Length > 0;
    public bool CanRequestCode => !Busy && Address.Contains('@');

    public async Task SubmitPasswordAsync(CancellationToken ct = default) =>
        await RunAsync(async () => Apply(await _auth.LoginAsync(Address, Password, ct)), canRun: CanSubmitPassword);

    public async Task RequestCodeAsync(CancellationToken ct = default) =>
        await RunAsync(async () =>
        {
            await _auth.RequestLoginCodeAsync(Address, ct);
            Step = SignInStep.Code;
            CodeEmailSent = true;
            Notice = "If that mailbox exists, a sign in code was sent to its recovery email.";
        }, canRun: CanRequestCode);

    public async Task SubmitCodeAsync(CancellationToken ct = default) =>
        await RunAsync(async () =>
        {
            if (Step == SignInStep.SecondFactor) Apply(await _auth.VerifySecondFactorAsync(Code, ct));
            else Apply(await _auth.VerifyLoginCodeAsync(Address, Code, ct));
        }, canRun: !Busy && Code.Trim().Length >= 6);

    /// <summary>Second factor fallback: email a one time code instead of using the authenticator app.</summary>
    public async Task EmailSecondFactorAsync(CancellationToken ct = default) =>
        await RunAsync(async () =>
        {
            await _auth.ChallengeSecondFactorAsync(ct);
            Notice = "A code was sent to your account email.";
        }, canRun: !Busy);

    public void Back()
    {
        Step = SignInStep.Password;
        Code = "";
        Error = null;
        Notice = null;
        CodeEmailSent = false;
    }

    private void Apply(LoginResult result)
    {
        Password = "";
        Code = "";
        Notice = null;
        if (result.RequiresSecondFactor)
        {
            Step = SignInStep.SecondFactor;
            return;
        }
        Session = result.Session;
        Step = SignInStep.Done;
        SignedIn?.Invoke(result.Session!);
    }

    private async Task RunAsync(Func<Task> work, bool canRun)
    {
        if (!canRun) return;
        Busy = true;
        Error = null;
        try { await work(); }
        catch (ApiRequestError e) { Error = Friendly(e); }
        catch (ApiTransportError) { Error = "Could not reach Taifa Mail."; Offline = true; }
        finally { Busy = false; }
    }

    internal static string Friendly(ApiRequestError e) => e.Status switch
    {
        401 => "Invalid address or password",
        423 => "This mailbox is temporarily locked. Try again later.",
        429 => "Too many attempts. Wait a minute and try again.",
        403 when e.Code == "mfa_enrolment_required" => "Set up two factor sign in on the web first.",
        403 when e.Code == "onboarding_required" => "Finish account setup on the web.",
        _ => e.Message,
    };
}
