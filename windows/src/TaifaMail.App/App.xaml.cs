using Microsoft.UI.Xaml;
using TaifaMail.App.Controls;
using TaifaMail.App.Services;

namespace TaifaMail.App;

public partial class App : Application
{
    public static MainWindow MainWindow { get; private set; } = null!;
    private AppServices? _services;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            // Last resort: log the type only. Never write message content or addresses to disk.
            try { File.AppendAllText(Path.Combine(AppServices.DataDir, "crash.log"), $"{DateTime.UtcNow:O} {e.Exception.GetType().FullName}\n"); } catch (Exception) { }
            // Only failures the app can recover from are swallowed (bad data, a failed request, a busy file); anything else ends the process.
            e.Handled = e.Exception is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError or System.Text.Json.JsonException
                or HttpRequestException or IOException or TaskCanceledException or OperationCanceledException or UnauthorizedAccessException;
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        // One instance: a second launch hands over to the first and exits before it can touch the WebView profile or temp files.
        var instance = Microsoft.Windows.AppLifecycle.AppInstance.FindOrRegisterForKey("taifa-mail-main");
        if (!instance.IsCurrent)
        {
            try { await instance.RedirectActivationToAsync(Microsoft.Windows.AppLifecycle.AppInstance.GetCurrent().GetActivatedEventArgs()); } catch (Exception) { }
            Environment.Exit(0);
            return;
        }
        instance.Activated += (_, _) => MainWindow?.DispatcherQueue.TryEnqueue(() => MainWindow.Activate());
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00FFFFFF");
        BodyWebView.WipeProfile();
        MainWindow = new MainWindow();
        MainWindow.Closed += (_, _) => { BodyWebView.WipeProfile(); AppServices.PurgeAttachments(); };
        MainWindow.Activate();

#if PREVIEW_DATA
        if (Preview.PreviewBoot.Requested(Environment.GetCommandLineArgs()))
        {
            await Preview.PreviewBoot.RunAsync(MainWindow, Environment.GetCommandLineArgs());
            return;
        }
#endif
        _services = new AppServices(MainWindow.DispatcherQueue);
        await new AppController(MainWindow, _services).StartAsync();
    }
}
