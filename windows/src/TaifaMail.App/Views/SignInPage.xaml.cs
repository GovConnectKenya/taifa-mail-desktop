using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using TaifaMail.Core.ViewModels;
using Windows.System;

namespace TaifaMail.App.Views;

public sealed partial class SignInPage : Page, Services.IChromePage
{
    public SignInViewModel Vm { get; }
    public FrameworkElement TitleBarElement => TitleRow;
    public IEnumerable<FrameworkElement> InteractiveElements => Array.Empty<FrameworkElement>();
    public void SetCaptionInset(double inset) { }

    public SignInPage(SignInViewModel vm, bool sessionEnded)
    {
        Vm = vm;
        InitializeComponent();
        EndedBar.IsOpen = sessionEnded;
        Loaded += (_, _) => (Vm.Address.Length == 0 ? AddressBox : (Control)PasswordField).Focus(FocusState.Programmatic);
        Vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(SignInViewModel.Step)) DispatcherQueue.TryEnqueue(() => { if (Vm.Step != SignInStep.Password) CodeBox.Focus(FocusState.Programmatic); });
        };
    }

    private async void OnSignIn(object sender, RoutedEventArgs e)
    {
        try { await Vm.SubmitPasswordAsync(); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }
    private async void OnEmailCode(object sender, RoutedEventArgs e)
    {
        try { await Vm.RequestCodeAsync(); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }
    private async void OnVerify(object sender, RoutedEventArgs e)
    {
        try { await Vm.SubmitCodeAsync(); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }
    private async void OnEmailSecondFactor(object sender, RoutedEventArgs e)
    {
        try { await Vm.EmailSecondFactorAsync(); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }
    private void OnBack(object sender, RoutedEventArgs e) => Vm.Back();

    private async void OnFieldKeyDown(object sender, KeyRoutedEventArgs e)
    {
        try { await OnFieldKeyDownCore(sender, e); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }

    private async Task OnFieldKeyDownCore(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter) { e.Handled = true; await Vm.SubmitPasswordAsync(); }
    }

    private async void OnCodeKeyDown(object sender, KeyRoutedEventArgs e)
    {
        try { await OnCodeKeyDownCore(sender, e); }
        catch (Exception ex) { Vm.Error = ex is TaifaMail.Core.Net.ApiRequestError or TaifaMail.Core.Net.ApiTransportError ? ex.Message : "Something went wrong. Try again."; }
    }

    private async Task OnCodeKeyDownCore(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter) { e.Handled = true; await Vm.SubmitCodeAsync(); }
    }
}
