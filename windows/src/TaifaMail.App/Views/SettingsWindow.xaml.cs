using System.Net;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using TaifaMail.App.Services;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;
using Windows.Graphics;

namespace TaifaMail.App.Views;

/// <summary>Settings (spec 8.9): General, Notifications, Signature, Auto-reply, Account. Each pane saves on its own and says so.</summary>
public sealed partial class SettingsWindow : Window
{
    private readonly ShellContext _ctx;
    private readonly Action<string> _densityChanged;
    private readonly Action _badgeChanged;
    private readonly SettingsApi? _api;
    private ApiMailBlock? _signature;
    private ApiAutoResponder? _auto;
    private bool _loadedSignature, _loadedAuto, _loadedAccount, _init;

    public SettingsWindow(ShellContext ctx, Action<string> densityChanged, Action badgeChanged)
    {
        _ctx = ctx;
        _densityChanged = densityChanged;
        _badgeChanged = badgeChanged;
        _api = ctx.Api is null ? null : new SettingsApi(ctx.Api);
        InitializeComponent();
        if (MicaController.IsSupported()) SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new SizeInt32(860, 600));
        var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "taifa.ico");
        if (File.Exists(ico)) AppWindow.SetIcon(ico);
        Root.RequestedTheme = ctx.Settings.Theme switch { "light" => ElementTheme.Light, "dark" => ElementTheme.Dark, _ => ElementTheme.Default };
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleRow);
        var close = new Microsoft.UI.Xaml.Input.KeyboardAccelerator { Key = Windows.System.VirtualKey.W, Modifiers = Windows.System.VirtualKeyModifiers.Control };
        close.Invoked += (_, e) => { Close(); e.Handled = true; };
        Root.KeyboardAccelerators.Add(close);

        ThemeChoice.SelectedIndex = ctx.Settings.Theme switch { "light" => 1, "dark" => 2, _ => 0 };
        DensityChoice.SelectedIndex = ctx.Settings.Density == "compact" ? 1 : 0;
        AlertsToggle.IsOn = ctx.Settings.NewMailAlerts;
        BadgeToggle.IsOn = ctx.Settings.TaskbarBadge;
        PreviewToggle.IsOn = ctx.Settings.ShowNotificationPreview;
        AccountAddress.Text = ctx.Me.Address;
        _init = true;
    }

    private void OnPaneChanged(object sender, SelectionChangedEventArgs e)
    {
        var tag = (Panes.SelectedItem as ListViewItem)?.Tag as string;
        GeneralPane.Visibility = tag == "General" ? Visibility.Visible : Visibility.Collapsed;
        NotificationsPane.Visibility = tag == "Notifications" ? Visibility.Visible : Visibility.Collapsed;
        SignaturePane.Visibility = tag == "Signature" ? Visibility.Visible : Visibility.Collapsed;
        AutoReplyPane.Visibility = tag == "AutoReply" ? Visibility.Visible : Visibility.Collapsed;
        AccountPane.Visibility = tag == "Account" ? Visibility.Visible : Visibility.Collapsed;
        if (tag == "Signature" && !_loadedSignature) { _loadedSignature = true; _ = LoadSignatureAsync(); }
        if (tag == "AutoReply" && !_loadedAuto) { _loadedAuto = true; _ = LoadAutoAsync(); }
        if (tag == "Account" && !_loadedAccount) { _loadedAccount = true; _ = LoadAccountAsync(); }
    }

    private async Task ShowErrorAsync(Exception ex)
    {
        try
        {
            await new ContentDialog { XamlRoot = Root.XamlRoot, Title = "Settings", Content = ex is ApiRequestError or ApiTransportError ? ex.Message : "Something went wrong. Try again.", CloseButtonText = "Close", RequestedTheme = Root.ActualTheme }.ShowAsync();
        }
        catch (Exception) { }
    }

    // ---- general and notifications (local) ----

    private void OnThemeChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_init) return;
        _ctx.Settings.Theme = ThemeChoice.SelectedIndex switch { 1 => "light", 2 => "dark", _ => "system" };
        _ctx.SaveSettings();
        _ctx.ApplyTheme(_ctx.Settings.Theme);
        Root.RequestedTheme = ThemeChoice.SelectedIndex switch { 1 => ElementTheme.Light, 2 => ElementTheme.Dark, _ => ElementTheme.Default };
    }

    private void OnDensityChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_init) return;
        _ctx.Settings.Density = DensityChoice.SelectedIndex == 1 ? "compact" : "comfortable";
        _ctx.SaveSettings();
        _densityChanged(_ctx.Settings.Density);
    }

    private void OnAlertsToggled(object sender, RoutedEventArgs e) { if (!_init) return; _ctx.Settings.NewMailAlerts = AlertsToggle.IsOn; _ctx.SaveSettings(); }
    private void OnPreviewToggled(object sender, RoutedEventArgs e) { if (!_init) return; _ctx.Settings.ShowNotificationPreview = PreviewToggle.IsOn; _ctx.SaveSettings(); }
    private void OnBadgeToggled(object sender, RoutedEventArgs e) { if (!_init) return; _ctx.Settings.TaskbarBadge = BadgeToggle.IsOn; _ctx.SaveSettings(); _badgeChanged(); }

    // ---- signature ----

    private async Task LoadSignatureAsync()
    {
        SignatureLoading.Visibility = Visibility.Visible;
        try
        {
            if (_api is null) throw new ApiTransportError("Not available in preview mode.");
            var blocks = await _api.BlocksAsync();
            _signature = blocks.Signatures.FirstOrDefault(b => b.IsDefault) ?? blocks.Signatures.FirstOrDefault();
            // a signature with a structured config was built in the web builder: show it read only, never overwrite it
            var structured = _signature?.IsStructured == true;
            SignatureBox.Text = !string.IsNullOrWhiteSpace(_signature?.Text) ? _signature!.Text! : TaifaMail.Core.Content.HtmlText.Strip(_signature?.Html ?? "");
            SignatureBox.IsReadOnly = structured;
            SaveSignatureButton.IsEnabled = !structured;
            SignatureWeb.IsOpen = structured;
            SignatureError.IsOpen = false;
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { SignatureError.Message = "Couldn't load your signature. " + e.Message; SignatureError.IsOpen = true; _loadedSignature = false; }
        finally { SignatureLoading.Visibility = Visibility.Collapsed; }
    }

    private async void OnEditSignatureOnWeb(object sender, RoutedEventArgs e)
    {
        try { await Windows.System.Launcher.LaunchUriAsync(new Uri("https://mail.govconnect.ke")); } catch (Exception) { }
    }

    private async void OnSaveSignature(object sender, RoutedEventArgs e)
    {
        try { await OnSaveSignatureCore(sender, e); }
        catch (Exception ex) { _ = ShowErrorAsync(ex); }
    }

    private async Task OnSaveSignatureCore(object sender, RoutedEventArgs e)
    {
        if (_api is null || _signature?.IsStructured == true) return;
        SignatureSaved.Text = "";
        var text = SignatureBox.Text.Replace("\r\n", "\n").Replace('\r', '\n');
        var html = WebUtility.HtmlEncode(text).Replace("\n", "<br>");
        try
        {
            _signature = _signature is null
                ? await _api.CreateSignatureAsync("Signature", html, text)
                : await _api.UpdateBlockAsync(_signature.Id, html, text);
            SignatureError.IsOpen = false;
            SignatureSaved.Text = "Saved";
        }
        catch (Exception ex) when (ex is ApiRequestError or ApiTransportError) { SignatureError.Message = ex is ApiTransportError ? "Could not reach Taifa Mail." : ex.Message; SignatureError.IsOpen = true; }
    }

    // ---- auto reply ----

    private async Task LoadAutoAsync()
    {
        AutoLoading.Visibility = Visibility.Visible;
        try
        {
            if (_api is null) throw new ApiTransportError("Not available in preview mode.");
            _auto = await _api.AutoResponderAsync();
            AutoEnabled.IsOn = _auto.Enabled;
            AutoSubject.Text = _auto.Subject ?? "";
            AutoMessage.Text = _auto.Text ?? "";
            AutoMode.SelectedIndex = _auto.Mode switch { "outside_hours" => 1, "date_range" => 2, _ => 0 };
            AutoStartHour.Value = _auto.StartHour;
            AutoEndHour.Value = _auto.EndHour;
            AutoStart.Date = DateTimeOffset.TryParse(_auto.StartAt, out var s) ? s : null;
            AutoEnd.Date = DateTimeOffset.TryParse(_auto.EndAt, out var en) ? en : null;
            AutoError.IsOpen = false;
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { AutoError.Message = "Couldn't load your auto-reply. " + e.Message; AutoError.IsOpen = true; _loadedAuto = false; }
        finally { AutoLoading.Visibility = Visibility.Collapsed; }
    }

    private void OnAutoModeChanged(object sender, SelectionChangedEventArgs e)
    {
        var mode = (AutoMode.SelectedItem as ComboBoxItem)?.Tag as string;
        AutoHours.Visibility = mode == "outside_hours" ? Visibility.Visible : Visibility.Collapsed;
        AutoRange.Visibility = mode == "date_range" ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnSaveAuto(object sender, RoutedEventArgs e)
    {
        try { await OnSaveAutoCore(sender, e); }
        catch (Exception ex) { _ = ShowErrorAsync(ex); }
    }

    private async Task OnSaveAutoCore(object sender, RoutedEventArgs e)
    {
        if (_api is null || _auto is null) return;
        AutoSaved.Text = "";
        var mode = (AutoMode.SelectedItem as ComboBoxItem)?.Tag as string ?? "always";
        var (config, error) = AutoReplyForm.Build(_auto, AutoEnabled.IsOn, AutoSubject.Text, AutoMessage.Text, mode, AutoStart.Date, AutoEnd.Date,
            double.IsNaN(AutoStartHour.Value) ? _auto.StartHour : (int)AutoStartHour.Value, double.IsNaN(AutoEndHour.Value) ? _auto.EndHour : (int)AutoEndHour.Value);
        if (config is null) { AutoError.Message = error ?? "Check the form."; AutoError.IsOpen = true; return; }
        try { _auto = await _api.SetAutoResponderAsync(config); AutoError.IsOpen = false; AutoSaved.Text = "Saved"; }
        catch (Exception ex) when (ex is ApiRequestError or ApiTransportError) { AutoError.Message = ex is ApiTransportError ? "Could not reach Taifa Mail." : ex.Message; AutoError.IsOpen = true; }
        catch (Exception) { AutoError.Message = "Could not save your auto-reply."; AutoError.IsOpen = true; }
    }

    // ---- account ----

    private async Task LoadAccountAsync()
    {
        try
        {
            var q = await _ctx.Mail.QuotaAsync();
            if (q is null) { AccountQuotaText.Text = ""; return; }
            AccountQuota.Value = q.Percent ?? (q.LimitBytes is > 0 ? 100.0 * q.UsedBytes / q.LimitBytes.Value : 0);
            AccountQuotaText.Text = q.LimitBytes is { } lim ? $"{ApiAttachmentExt.Human(q.UsedBytes)} of {ApiAttachmentExt.Human(lim)} used" : $"{ApiAttachmentExt.Human(q.UsedBytes)} used";
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { AccountQuotaText.Text = "Storage is unavailable right now."; _loadedAccount = false; }
    }

    private async void OnSignOut(object sender, RoutedEventArgs e)
    {
        try { await OnSignOutCore(sender, e); }
        catch (Exception ex) { _ = ShowErrorAsync(ex); }
    }

    private async Task OnSignOutCore(object sender, RoutedEventArgs e)
    {
        Close();
        await _ctx.SignOut();
    }
}
