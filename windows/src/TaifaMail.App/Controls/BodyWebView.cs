using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using TaifaMail.Core.Content;
using TaifaMail.Core.Security;

namespace TaifaMail.App.Controls;

/// <summary>
/// The only web content in the app: the HTML body of one received message.
/// Locked down: script off, one navigation only (our own document), downloads and frames cancelled,
/// remote loads denied (images only through the server image proxy once allowed for this message),
/// no dev tools, copy only in the context menu, app private data folder wiped at start and exit,
/// height reported from layout so the reader scrolls as one column.
/// </summary>
public sealed class BodyWebView : UserControl
{
    private static CoreWebView2Environment? _env;
    private static readonly SemaphoreSlim EnvGate = new(1, 1);
    private const string FontHost = "taifa-fonts.local";

    /// <summary>Set by the shell: the API origin, the mailbox, and a way to fetch a proxied image with the session cookies.</summary>
    public static Func<string, Task<byte[]?>>? ProxyFetcher { get; set; }
    public static string ApiBase { get; set; } = "";
    public static string MailboxId { get; set; } = "";
    public static Func<Task<string?>>? CapabilityProvider { get; set; }

    public static string UserDataFolder { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TaifaMail", "webview");

    private readonly WebView2 _web = new() { MinHeight = 24 };
    private Dictionary<string, string> _linkTexts = new();
    private bool _allowImages;
    private bool _ready;
    private bool _allowNextNavigation;
    private string? _pendingDoc;

    /// <summary>Raised when the page wants to scroll (wheel over the view); the reader scrolls its column.</summary>
    public event Action<double>? WheelForwarded;
    public event Action<string, string?>? LinkRequested;
    public event Action? FailedToStart;
    public bool Failed { get; private set; }

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
        try { return _env ??= await CoreWebView2Environment.CreateAsync(null, UserDataFolder); }
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
            core.FrameNavigationStarting += (_, e) => e.Cancel = true;
            core.DownloadStarting += (_, e) => { e.Cancel = true; e.Handled = true; };
            core.NewWindowRequested += (_, e) => { e.Handled = true; Raise(e.Uri); };
            core.ContextMenuRequested += (_, e) =>
            {
                var items = e.MenuItems;
                for (var i = items.Count - 1; i >= 0; i--) if (items[i].Name != "copy") items.RemoveAt(i);
            };
            // Our own fonts, served from the app folder through a virtual host (read only, never the network).
            core.SetVirtualHostNameToFolderMapping(FontHost, Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts"), CoreWebView2HostResourceAccessKind.Allow);
            core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += async (_, e) => await OnResourceAsync(env, e);
            core.NavigationCompleted += async (_, _) => { await InstallWheelAsync(); await MeasureAsync(); };
            core.WebMessageReceived += (_, e) =>
            {
                if (double.TryParse(e.TryGetWebMessageAsString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var dy)) WheelForwarded?.Invoke(dy);
            };
            _ready = true;
            if (_pendingDoc is not null) Navigate(_pendingDoc);
        }
        catch (Exception)
        {
            // WebView2 runtime missing or failed: the reader shows the plain text alternative instead.
            Failed = true;
            FailedToStart?.Invoke();
        }
    }

    private async Task OnResourceAsync(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var u)) { e.Response = env.CreateWebResourceResponse(null, 403, "Blocked", ""); return; }
            if (u.Host == FontHost) return;
            // Images allowed for this message go through the server image proxy, fetched here with the session cookies.
            if (_allowImages && e.ResourceContext == CoreWebView2WebResourceContext.Image && ImageProxy.IsProxyRequest(u, ApiBase, MailboxId) && ProxyFetcher is { } fetch)
            {
                var deferral = e.GetDeferral();
                try
                {
                    var bytes = await fetch(e.Request.Uri);
                    if (bytes is { Length: > 0 })
                    {
                        var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                        await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(bytes));
                        stream.Seek(0);
                        e.Response = env.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: image/*\nCache-Control: no-store");
                    }
                    else e.Response = env.CreateWebResourceResponse(null, 404, "Not found", "");
                }
                finally { deferral.Complete(); }
                return;
            }
            e.Response = env.CreateWebResourceResponse(null, 403, "Blocked", "");
        }
        catch (Exception)
        {
            try { e.Response = env.CreateWebResourceResponse(null, 403, "Blocked", ""); } catch (Exception) { }
        }
    }

    /// <summary>Only our own document may load: the first navigation we start ourselves. Everything else is cancelled.</summary>
    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var uri = e.Uri ?? "";
        if (_allowNextNavigation && !e.IsUserInitiated && (uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)))
        {
            _allowNextNavigation = false;
            return;
        }
        e.Cancel = true;
        if (e.IsUserInitiated) Raise(uri);
    }

    private void Raise(string uri)
    {
        _linkTexts.TryGetValue(uri, out var text);
        LinkRequested?.Invoke(uri, text);
    }

    private void Navigate(string doc)
    {
        _allowNextNavigation = true;
        _web.CoreWebView2.NavigateToString(doc);
    }

    /// <summary>Renders the message. Never throws: a body that cannot be shown here falls back to plain text.</summary>
    public async void Show(string html, bool allowImages, bool dark)
    {
        try
        {
            _allowImages = allowImages;
            if (allowImages && CapabilityProvider is { } cap && await cap() is { Length: > 0 } token)
                html = ImageProxy.Rewrite(html, ApiBase, MailboxId, token);
            _linkTexts = HtmlBody.LinkTexts(html);
            var colors = dark ? new BodyColors("#ECECEC", "#8ADBAA") : new BodyColors("#000000", "#00643A");
            var imgOrigin = allowImages ? ApiBase : null;
            var doc = HtmlBody.Wrap(html, allowImages, dark, colors, "https://" + FontHost, imgOrigin);
            if (!HtmlBody.FitsNavigateToString(doc)) { Failed = true; FailedToStart?.Invoke(); return; }
            if (_ready) Navigate(doc); else _pendingDoc = doc;
        }
        catch (Exception)
        {
            Failed = true;
            FailedToStart?.Invoke();
        }
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
        try { foreach (var ms in new[] { 400, 1500, 4000 }) { await Task.Delay(ms); await MeasureAsync(); } }
        catch (Exception) { }
    }

    public void Close()
    {
        try { _web.Close(); } catch (Exception) { }
    }
}
