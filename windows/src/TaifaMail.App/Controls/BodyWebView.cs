using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using TaifaMail.App.Services;
using TaifaMail.Core.Content;
using Windows.System;

namespace TaifaMail.App.Controls;

/// <summary>
/// The only web content in the app: the HTML body of one received message.
/// Locked down: script off, no in-view navigation, remote loads denied until allowed for this message,
/// no dev tools, copy only in the context menu, app private data folder wiped at start and exit,
/// height reported from layout so the reader scrolls as one column.
/// </summary>
public sealed class BodyWebView : UserControl
{
    private static CoreWebView2Environment? _env;
    private static readonly SemaphoreSlim EnvGate = new(1, 1);

    public static string UserDataFolder { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TaifaMail", "webview");

    private readonly WebView2 _web = new() { MinHeight = 24 };
    private Dictionary<string, string> _linkTexts = new();
    private bool _allowImages;
    private bool _ready;
    private string? _pendingDoc;

    /// <summary>Raised when the page wants to scroll (wheel over the view); the reader scrolls its column.</summary>
    public event Action<double>? WheelForwarded;
    public event Action<string, string?>? LinkRequested;

    public BodyWebView()
    {
        IsTabStop = false;
        Content = _web;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        _web.SizeChanged += (_, e) => { if (e.NewSize.Width != e.PreviousSize.Width) _ = MeasureAsync(); };
        _ = InitAsync();
    }

    /// <summary>Removes any profile left by a previous run. Called once at startup and at exit.</summary>
    public static void WipeProfile()
    {
        try { if (Directory.Exists(UserDataFolder)) Directory.Delete(UserDataFolder, true); } catch (Exception) { }
    }

    private static async Task<CoreWebView2Environment> EnvAsync()
    {
        await EnvGate.WaitAsync();
        try
        {
            return _env ??= await CoreWebView2Environment.CreateWithOptionsAsync(null, UserDataFolder, new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--disable-features=msSmartScreenProtection" });
        }
        finally { EnvGate.Release(); }
    }

    private async Task InitAsync()
    {
        try
        {
            var env = await EnvAsync();
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            var s = core.Settings;
            s.IsScriptEnabled = false;
            s.AreDevToolsEnabled = false;
            s.AreDefaultContextMenusEnabled = true;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsWebMessageEnabled = true;
            s.AreHostObjectsAllowed = false;
            s.IsBuiltInErrorPageEnabled = false;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += (_, e) => { e.Handled = true; Raise(e.Uri); };
            core.ContextMenuRequested += (_, e) =>
            {
                var items = e.MenuItems;
                for (var i = items.Count - 1; i >= 0; i--) if (items[i].Name != "copy") items.RemoveAt(i);
            };
            core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                // Even when images are allowed for this message, only images may load: no css, fonts, frames or scripts.
                if (_allowImages && e.ResourceContext == CoreWebView2WebResourceContext.Image) return;
                e.Response = env.CreateWebResourceResponse(null, 403, "Blocked", "");
            };
            core.NavigationCompleted += async (_, _) => { await InstallWheelAsync(); await MeasureAsync(); };
            core.WebMessageReceived += (_, e) =>
            {
                if (double.TryParse(e.TryGetWebMessageAsString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var dy)) WheelForwarded?.Invoke(dy);
            };
            _ready = true;
            if (_pendingDoc is not null) core.NavigateToString(_pendingDoc);
        }
        catch (Exception)
        {
            // WebView2 runtime missing or failed: the reader shows the plain text alternative instead.
            Failed = true;
            FailedToStart?.Invoke();
        }
    }

    public bool Failed { get; private set; }
    public event Action? FailedToStart;

    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var uri = e.Uri ?? "";
        var ours = !e.IsUserInitiated && (uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase));
        if (ours) return;
        e.Cancel = true;
        if (e.IsUserInitiated) Raise(uri);
    }

    private void Raise(string uri)
    {
        _linkTexts.TryGetValue(uri, out var text);
        LinkRequested?.Invoke(uri, text);
    }

    public void Show(string html, bool allowImages, bool dark)
    {
        _allowImages = allowImages;
        _linkTexts = HtmlBody.LinkTexts(html);
        var colors = dark ? new BodyColors("#F8F3F0", "#1EA94E", "#161312") : new BodyColors("#050100", "#006900", "#FFFFFF");
        var doc = HtmlBody.Wrap(html, allowImages, dark, colors);
        if (_ready) _web.CoreWebView2.NavigateToString(doc); else _pendingDoc = doc;
    }

    private async Task InstallWheelAsync()
    {
        try { await _web.CoreWebView2.ExecuteScriptAsync("window.addEventListener('wheel',function(e){window.chrome.webview.postMessage(String(e.deltaY));},{passive:true});"); }
        catch (Exception) { }
    }

    private async Task MeasureAsync()
    {
        if (!_ready) return;
        try
        {
            var raw = await _web.CoreWebView2.ExecuteScriptAsync("Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))");
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var h) && h > 0) _web.Height = Math.Min(h + 2, 60000);
        }
        catch (Exception) { }
    }

    /// <summary>Re-measure after remote images arrive.</summary>
    public async void RemeasureSoon()
    {
        foreach (var ms in new[] { 400, 1500, 4000 }) { await Task.Delay(ms); await MeasureAsync(); }
    }

    public void Close()
    {
        try { _web.Close(); } catch (Exception) { }
    }
}
