using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using TaifaMail.App.Services;
using Windows.System;

namespace TaifaMail.App.Views;

/// <summary>Shown instead of the mailbox while a new password or recovery email is still outstanding. That step happens on the web.</summary>
public sealed partial class WebSetupPage : Page, IChromePage
{
    private readonly Func<Task> _signOut;

    public WebSetupPage(string address, Func<Task> signOut)
    {
        _signOut = signOut;
        InitializeComponent();
        Body.Text = $"{address} needs a new password or a recovery email before it can be used here. Complete this on the web, then sign in again.";
    }

    public FrameworkElement TitleBarElement => TitleRow;
    public IEnumerable<FrameworkElement> InteractiveElements => Array.Empty<FrameworkElement>();
    public void SetCaptionInset(double inset) { }

    private async void OnOpenWeb(object sender, RoutedEventArgs e)
    {
        try { await Launcher.LaunchUriAsync(new Uri("https://mail.govconnect.ke")); } catch (Exception) { }
    }

    private async void OnSignOut(object sender, RoutedEventArgs e)
    {
        try { await _signOut(); } catch (Exception) { }
    }
}
