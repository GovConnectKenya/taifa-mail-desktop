using System.Collections.ObjectModel;
using System.Collections.Specialized;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using TaifaMail.Core.Compose;
using Windows.System;

namespace TaifaMail.App.Controls;

/// <summary>To, Cc or Bcc: token chips (24 high, pill) with address suggestions; invalid addresses show a danger chip.</summary>
public sealed class RecipientBox : UserControl
{
    private readonly ComposeViewModel _vm;
    private readonly ObservableCollection<RecipientChip> _field;
    private readonly IReadOnlyList<string> _thread;
    private readonly WrapPanel _panel = new();
    private readonly AutoSuggestBox _input = new() { MinWidth = 180, PlaceholderText = "", BorderThickness = new Thickness(0), Background = null, VerticalAlignment = VerticalAlignment.Center };
    private CancellationTokenSource? _suggestCts;

    public RecipientBox(ComposeViewModel vm, ObservableCollection<RecipientChip> field, IReadOnlyList<string> threadAddresses, string automationName)
    {
        _vm = vm;
        _field = field;
        _thread = threadAddresses;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_input, automationName);
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        Content = _panel;
        _input.TextChanged += OnTextChanged;
        _input.SuggestionChosen += (_, e) => { Commit(e.SelectedItem?.ToString() ?? ""); };
        _input.QuerySubmitted += (_, e) => Commit(e.ChosenSuggestion?.ToString() ?? e.QueryText);
        _input.LostFocus += (_, _) => Commit(_input.Text);
        _input.KeyDown += OnKeyDown;
        _field.CollectionChanged += (_, _) => Rebuild();
        Rebuild();
    }

    public void FocusInput() => _input.Focus(FocusState.Programmatic);

    private void Commit(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        _vm.AddRecipient(_field, text);
        _input.Text = "";
        _input.ItemsSource = null;
    }

    private async void OnTextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs e)
    {
        if (e.Reason != AutoSuggestionBoxTextChangeReason.UserInput) return;
        var text = sender.Text;
        if (text.EndsWith(',') || text.EndsWith(';')) { Commit(text.TrimEnd(',', ';')); return; }
        _suggestCts?.Cancel();
        var cts = _suggestCts = new CancellationTokenSource();
        try
        {
            await Task.Delay(180, cts.Token);
            var items = await _vm.SuggestAsync(text, _thread, cts.Token);
            if (!cts.IsCancellationRequested) sender.ItemsSource = items;
        }
        catch (OperationCanceledException) { }
    }

    private void OnKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Back && _input.Text.Length == 0 && _field.Count > 0) { _vm.RemoveRecipient(_field, _field[^1]); e.Handled = true; }
    }

    private void Rebuild()
    {
        _panel.Children.Clear();
        foreach (var chip in _field)
        {
            var bg = chip.Valid ? "{ThemeResource TmPanel2Brush}" : "{ThemeResource TmDangerSoftBrush}";
            var fg = chip.Valid ? "{ThemeResource TmTextBrush}" : "{ThemeResource TmDangerFgBrush}";
            var xaml = $@"<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' CornerRadius='12' Height='24' Padding='10,0,2,0' Margin='0,2,6,2' Background='{bg}'>
  <StackPanel Orientation='Horizontal' Spacing='2'>
    <TextBlock x:Name='Label' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' FontFamily='{{StaticResource TmFontMedium}}' FontSize='12' Foreground='{fg}' VerticalAlignment='Center'/>
    <Button x:Name='Remove' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Width='20' Height='20' MinWidth='0' MinHeight='0' Padding='0' CornerRadius='10' Background='Transparent' BorderThickness='0' Content='&#215;' FontSize='13' Foreground='{fg}'/>
  </StackPanel>
</Border>";
            var root = (Border)XamlReader.Load(xaml);
            ((TextBlock)root.FindName("Label")).Text = chip.Display;
            var remove = (Button)root.FindName("Remove");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(remove, "Remove " + chip.Address);
            ToolTipService.SetToolTip(root, chip.Valid ? chip.Address : $"{chip.Address} is not a valid address");
            var c = chip;
            remove.Click += (_, _) => _vm.RemoveRecipient(_field, c);
            _panel.Children.Add(root);
        }
        _panel.Children.Add(_input);
    }
}
