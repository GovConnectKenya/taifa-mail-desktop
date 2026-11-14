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
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        BodyWebView.WipeProfile();
        MainWindow = new MainWindow();
        MainWindow.Closed += (_, _) => BodyWebView.WipeProfile();
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
