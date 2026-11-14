using Microsoft.UI.Dispatching;
using TaifaMail.Core.Cache;
using TaifaMail.Core.Net;
using TaifaMail.Core.ViewModels;

namespace TaifaMail.App.Services;

/// <summary>Composition root for the real app: one API client, its stores and caches, all under %LOCALAPPDATA%\TaifaMail.</summary>
public sealed class AppServices
{
    public static string DataDir { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TaifaMail");
    public static string SettingsPath => Path.Combine(DataDir, "settings.json");

    public TaifaApiClient Api { get; }
    public AuthApi Auth { get; }
    public OfflineCache Cache { get; }
    public ImageCache Images { get; }
    public LocalSettings Settings { get; private set; }
    public NotificationService Notifications { get; } = new();

    public AppServices(DispatcherQueue ui)
    {
        Directory.CreateDirectory(DataDir);
        Api = new TaifaApiClient(TaifaApiClient.ProductionBase, new DpapiSessionStore(Path.Combine(DataDir, "session.bin")));
        Auth = new AuthApi(Api);
        Cache = new OfflineCache(Path.Combine(DataDir, "cache.db"));
        Images = new ImageCache(Api, Path.Combine(DataDir, "img"), ui);
        ImageCache.Instance = Images;
        Settings = LocalSettings.Load(SettingsPath);
    }

    public MailApi MailFor(string mailboxId) => new(Api, mailboxId);

    public void SaveSettings() => Settings.Save(SettingsPath);

    /// <summary>Signing out removes everything tied to the session: cookies, cached mail, pictures, opened attachments.</summary>
    public async Task SignOutAsync()
    {
        await Auth.LogoutAsync();
        WipeLocal();
    }

    public void WipeLocal()
    {
        Api.ClearSession();
        Cache.Clear();
        Images.Clear();
        try { var att = Path.Combine(Path.GetTempPath(), "TaifaMail", "att"); if (Directory.Exists(att)) Directory.Delete(att, true); } catch (IOException) { }
        Settings.LastMailboxId = null;
        SaveSettings();
    }
}
