using Microsoft.UI.Xaml;
using TaifaMail.App.Views;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;

namespace TaifaMail.App.Services;

/// <summary>Decides which page is showing: sign in or the mailbox, and moves between them.</summary>
public sealed class AppController
{
    private readonly MainWindow _window;
    private readonly AppServices _svc;
    private int _generation;

    public AppController(MainWindow window, AppServices svc)
    {
        _window = window;
        _svc = svc;
        _svc.Api.SessionExpired += () => _window.DispatcherQueue.TryEnqueue(() => ShowSignIn(sessionEnded: true));
    }

    public async Task StartAsync()
    {
        _window.ApplyTheme(_svc.Settings.Theme);
        if (_svc.Api.HasStoredSession && _svc.Settings.LastMailboxId is { } id && _svc.Settings.LastAddress is { } address)
        {
            // Cold start: paint the cached inbox now, validate the session in the background.
            ShowShell(new MailboxMe(id, address, null, null, null, null));
            var gen = _generation;
            try
            {
                var me = await _svc.Auth.MeAsync();
                if (gen != _generation) return;
                _svc.Settings.LastMailboxId = me.MailboxId;
                _svc.Settings.LastAddress = me.Address;
                _svc.SaveSettings();
            }
            catch (ApiTransportError) { /* offline: the cached inbox stays, the shell shows its offline banner */ }
            catch (ApiRequestError) { /* SessionExpired already moved us to sign in */ }
            return;
        }
        ShowSignIn(sessionEnded: false);
    }

    public void ShowSignIn(bool sessionEnded)
    {
        _generation++;
        if (sessionEnded) _svc.WipeLocal();
        var vm = new SignInViewModel(_svc.Auth);
        vm.SignedIn += async session =>
        {
            _svc.Settings.LastMailboxId = session.MailboxId;
            _svc.Settings.LastAddress = session.Address;
            _svc.SaveSettings();
            MailboxMe me;
            try { me = await _svc.Auth.MeAsync(); }
            catch (Exception) { me = new MailboxMe(session.MailboxId, session.Address, session.OrgId, null, null, null); }
            ShowShell(me);
        };
        if (_svc.Settings.LastAddress is { } last) vm.Address = last;
        _window.Show(new SignInPage(vm, sessionEnded));
    }

    public void ShowShell(MailboxMe me)
    {
        _generation++;
        var ctx = new ShellContext
        {
            Mail = _svc.MailFor(me.MailboxId),
            RealMail = _svc.MailFor(me.MailboxId),
            Auth = _svc.Auth,
            Me = me,
            ApiBase = _svc.Api.BaseUri.ToString().TrimEnd('/'),
            Cache = _svc.Cache,
            Settings = _svc.Settings,
            SignOut = async () => { await _svc.SignOutAsync(); ShowSignIn(sessionEnded: false); },
            SwitchMailbox = async mailboxId =>
            {
                try
                {
                    await _svc.Auth.SwitchAsync(mailboxId);
                    _svc.Cache.Clear();
                    _svc.Images.Clear();
                    var next = await _svc.Auth.MeAsync();
                    _svc.Settings.LastMailboxId = next.MailboxId;
                    _svc.Settings.LastAddress = next.Address;
                    _svc.SaveSettings();
                    ShowShell(next);
                }
                catch (ApiRequestError) { }
                catch (ApiTransportError) { }
            },
        };
        _window.Show(new ShellPage(ctx));
    }
}
