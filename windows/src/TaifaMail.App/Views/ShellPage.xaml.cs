using System.Collections.Specialized;
using System.ComponentModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using TaifaMail.App.Controls;
using TaifaMail.App.Services;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Content;
using TaifaMail.Core.Models;
using TaifaMail.Core.ViewModels;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;

namespace TaifaMail.App.Views;

public sealed partial class ShellPage : Page, IChromePage
{
    public MailShellViewModel Vm { get; }
    private readonly ShellContext _ctx;
    private List<SwitchableMailbox> _siblings = new();
    private CancellationTokenSource? _searchDelay;
    private ScrollViewer? _listScroll;
    private bool _buildingNav;
    private bool _draggingSplitter;
    private double _splitterStartX, _splitterStartWidth;

    public FrameworkElement TitleBarElement => TitleRow;
    public IEnumerable<FrameworkElement> InteractiveElements => new FrameworkElement[] { SearchHost, CommandHost };
    public void SetCaptionInset(double inset) => CaptionInsetColumn.Width = new GridLength(Math.Max(0, inset));

    public ShellPage(ShellContext ctx)
    {
        _ctx = ctx;
        Vm = new MailShellViewModel(ctx.Mail, ctx.ApiBase, ctx.Cache) { OwnAddress = ctx.Me.Address };
        InitializeComponent();
        Skeleton.ItemsSource = new int[8];

        IdentityName.Text = string.IsNullOrWhiteSpace(ctx.Me.DisplayName) ? ctx.Me.Address : ctx.Me.DisplayName;
        IdentityAddress.Text = ctx.Me.Address;
        var (letter, color) = AvatarRule.Placeholder(ctx.Me.Address, ctx.Me.DisplayName);
        IdentityAvatar.Initials = letter;
        IdentityAvatar.FillColor = color;
        if (AvatarRule.TrustedUrl(ctx.Me.AvatarUrl, ctx.ApiBase) is { } own)
            IdentityAvatar.Decision = new AvatarDecision(AvatarKind.Photo, own, ctx.Me.Address);

        Vm.Folders.CollectionChanged += (_, _) => DispatcherQueue.TryEnqueue(RebuildNav);
        Vm.Threads.CollectionChanged += (_, _) => UpdateListState();
        Vm.OpenMessages.CollectionChanged += OnOpenMessagesChanged;
        Vm.PropertyChanged += OnVmChanged;

        AddAccelerator(VirtualKey.F5, VirtualKeyModifiers.None, () => _ = Vm.ReconcileAsync());
        AddAccelerator(VirtualKey.E, VirtualKeyModifiers.Control, () => SearchBox.Focus(FocusState.Programmatic));
        Loaded += async (_, _) =>
        {
            UpdateListState();
            UpdateReaderState();
            await Vm.StartAsync();
            try { _siblings = await _ctx.Auth.SwitchableAsync(); } catch (Exception) { }
        };
    }

    private void AddAccelerator(VirtualKey key, VirtualKeyModifiers mods, Action action)
    {
        var a = new KeyboardAccelerator { Key = key, Modifiers = mods };
        a.Invoked += (_, e) => { action(); e.Handled = true; };
        KeyboardAccelerators.Add(a);
    }

    // ---- state ----

    private void OnVmChanged(object? sender, PropertyChangedEventArgs e)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            switch (e.PropertyName)
            {
                case nameof(MailShellViewModel.Loading):
                case nameof(MailShellViewModel.IsEmpty):
                case nameof(MailShellViewModel.Searching):
                case nameof(MailShellViewModel.SelectedFolder):
                    UpdateListState();
                    break;
                case nameof(MailShellViewModel.OpenLoading):
                case nameof(MailShellViewModel.OpenError):
                case nameof(MailShellViewModel.SelectedThread):
                    UpdateReaderState();
                    break;
            }
        });
    }

    private void UpdateListState()
    {
        ListTitle.Text = Vm.Searching ? $"Search: {Vm.SearchText}" : (Vm.SelectedFolder?.Name ?? "");
        var loadingEmpty = Vm.Loading && Vm.Threads.Count == 0;
        Skeleton.Visibility = loadingEmpty ? Visibility.Visible : Visibility.Collapsed;
        var empty = !Vm.Loading && Vm.Threads.Count == 0 && Vm.SelectedFolder is not null;
        EmptyState.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        EmptyHint.Text = Vm.Searching ? "No messages match your search." : "This folder has no messages.";
    }

    private void UpdateReaderState()
    {
        var hasCards = Vm.OpenMessages.Count > 0;
        var loading = Vm.SelectedThread is not null && Vm.OpenLoading && !hasCards;
        var failed = Vm.SelectedThread is not null && !Vm.OpenLoading && !hasCards && !string.IsNullOrEmpty(Vm.OpenError);
        ReaderScroll.Visibility = hasCards ? Visibility.Visible : Visibility.Collapsed;
        ReaderSkeleton.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        ReaderError.Visibility = failed ? Visibility.Visible : Visibility.Collapsed;
        ReaderEmpty.Visibility = Vm.SelectedThread is null || (!hasCards && !loading && !failed) ? Visibility.Visible : Visibility.Collapsed;
        ReaderErrorText.Text = Vm.OpenError ?? "";
        if (hasCards) ReaderSubject.Text = Vm.OpenMessages[^1].Subject;
    }

    private void OnOpenMessagesChanged(object? sender, NotifyCollectionChangedEventArgs e) => DispatcherQueue.TryEnqueue(UpdateReaderState);

    // ---- sidebar ----

    private void RebuildNav()
    {
        _buildingNav = true;
        try
        {
            Nav.MenuItems.Clear();
            var addedHeader = false;
            NavigationViewItem? selected = null;
            foreach (var f in Vm.Folders)
            {
                var special = Fmt.IconFor(f) != "folder";
                if (!special && !addedHeader)
                {
                    addedHeader = true;
                    Nav.MenuItems.Add(new NavigationViewItemHeader { Content = "Folders" });
                }
                var item = BuildFolderItem(f);
                Nav.MenuItems.Add(item);
                if (Vm.SelectedFolder?.Path == f.Path) selected = item;
            }
            if (selected is not null) Nav.SelectedItem = selected;
        }
        finally { _buildingNav = false; }
    }

    private NavigationViewItem BuildFolderItem(ApiFolder f)
    {
        var grid = new Grid { ColumnSpacing = 8, Height = 24 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var icon = new IconView { IconName = Fmt.IconFor(f), Size = 16, VerticalAlignment = VerticalAlignment.Center };
        icon.SetValue(Grid.ColumnProperty, 0);
        var label = new TextBlock { Text = f.Name, Style = (Style)Application.Current.Resources["TmBody"], VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        label.SetValue(Grid.ColumnProperty, 1);
        var badgeText = Fmt.FolderBadge(f);
        var badge = new TextBlock { Text = badgeText, Style = (Style)Application.Current.Resources["TmCaption"], VerticalAlignment = VerticalAlignment.Center, Visibility = badgeText.Length > 0 ? Visibility.Visible : Visibility.Collapsed };
        badge.SetValue(Grid.ColumnProperty, 2);
        grid.Children.Add(icon);
        grid.Children.Add(label);
        grid.Children.Add(badge);
        var item = new NavigationViewItem { Content = grid, Tag = f, MinHeight = 32, Height = 32 };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, badgeText.Length > 0 ? $"{f.Name}, {badgeText}" : f.Name);
        return item;
    }

    private void OnFolderSelected(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (_buildingNav || args.SelectedItemContainer?.Tag is not ApiFolder folder) return;
        if (Vm.SelectedFolder?.Path == folder.Path && Vm.Threads.Count > 0 && !Vm.Searching) return;
        SearchBox.Text = "";
        Vm.SelectedThread = null;
        Vm.OpenMessages.Clear();
        _ = Vm.LoadFolderAsync(folder);
    }

    private void OnIdentityOpening(object? sender, object e)
    {
        IdentityFlyout.Items.Clear();
        foreach (var mb in _siblings)
        {
            var item = new MenuFlyoutItem { Text = string.IsNullOrWhiteSpace(mb.DisplayName) ? mb.Address : $"{mb.DisplayName} ({mb.Address})", Tag = mb.MailboxId };
            item.Click += async (s, _) => await _ctx.SwitchMailbox((string)((MenuFlyoutItem)s).Tag);
            IdentityFlyout.Items.Add(item);
        }
        if (_siblings.Count > 0) IdentityFlyout.Items.Add(new MenuFlyoutSeparator());
        var signOut = new MenuFlyoutItem { Text = "Sign out" };
        signOut.Click += async (_, _) => await _ctx.SignOut();
        IdentityFlyout.Items.Add(signOut);
    }

    // ---- thread list ----

    private void OnThreadListLoaded(object sender, RoutedEventArgs e)
    {
        _listScroll = FindChild<ScrollViewer>(ThreadList);
        if (_listScroll is not null) _listScroll.ViewChanged += (_, _) =>
        {
            if (_listScroll.ExtentHeight - _listScroll.VerticalOffset - _listScroll.ViewportHeight < 10 * 76) _ = Vm.LoadMoreAsync();
        };
    }

    private void OnThreadSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var count = ThreadList.SelectedItems.Count;
        SelectedCount.Visibility = count > 1 ? Visibility.Visible : Visibility.Collapsed;
        SelectedCount.Text = $"{count} selected";
        if (count == 1 && ThreadList.SelectedItem is ThreadRow row && !ReferenceEquals(Vm.SelectedThread, row)) _ = Vm.OpenAsync(row);
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => _ = Vm.ReconcileAsync();
    private void OnRetryOpen(object sender, RoutedEventArgs e) { if (Vm.SelectedThread is { } r) _ = Vm.OpenAsync(r); }

    // ---- search ----

    private void OnSearchTextChanged(object sender, TextChangedEventArgs e)
    {
        _searchDelay?.Cancel();
        var cts = _searchDelay = new CancellationTokenSource();
        var text = SearchBox.Text;
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(350, cts.Token); } catch (OperationCanceledException) { return; }
            DispatcherQueue.TryEnqueue(() => { if (!cts.IsCancellationRequested) _ = Vm.SearchAsync(text); });
        });
    }

    private void OnSearchKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Escape) { SearchBox.Text = ""; ThreadList.Focus(FocusState.Programmatic); e.Handled = true; }
    }

    // ---- splitter ----

    private void OnSplitterPressed(object sender, PointerRoutedEventArgs e)
    {
        _draggingSplitter = true;
        _splitterStartX = e.GetCurrentPoint(Panes).Position.X;
        _splitterStartWidth = ListColumn.ActualWidth;
        ((UIElement)sender).CapturePointer(e.Pointer);
    }

    private void OnSplitterMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_draggingSplitter) return;
        var dx = e.GetCurrentPoint(Panes).Position.X - _splitterStartX;
        ListColumn.Width = new GridLength(Math.Clamp(_splitterStartWidth + dx, 300, 480));
    }

    private void OnSplitterReleased(object sender, PointerRoutedEventArgs e)
    {
        _draggingSplitter = false;
        ((UIElement)sender).ReleasePointerCapture(e.Pointer);
    }

    // ---- reader cards ----

    private void OnCardHeaderTapped(object sender, TappedRoutedEventArgs e)
    {
        if (((FrameworkElement)sender).DataContext is MessageCardVm card) card.Expanded = !card.Expanded;
    }

    private void OnShowImages(object sender, RoutedEventArgs e)
    {
        if (FindCard((DependencyObject)sender) is { } card) card.AllowImages = true;
    }

    private void OnBodyHostLoaded(object sender, RoutedEventArgs e)
    {
        var host = (ContentControl)sender;
        if (host.Content is not null || host.DataContext is not MessageCardVm card) return;
        if (card.HasHtml)
        {
            var web = new BodyWebView();
            void Render() => web.Show(card.Detail.Html!, card.AllowImages, ActualTheme == ElementTheme.Dark);
            web.LinkRequested += (uri, text) => { if (!card.LinksDisabled) _ = PromptAndOpenAsync(uri, text); };
            web.WheelForwarded += dy => ReaderScroll.ChangeView(null, ReaderScroll.VerticalOffset + dy, null, true);
            web.FailedToStart += () => DispatcherQueue.TryEnqueue(() => host.Content = BuildPlainText(card.PlainText));
            card.PropertyChanged += (_, args) =>
            {
                if (args.PropertyName == nameof(MessageCardVm.AllowImages)) { Render(); if (card.AllowImages) web.RemeasureSoon(); }
            };
            ActualThemeChanged += (_, _) => Render();
            host.Content = web;
            Render();
            host.Unloaded += (_, _) => web.Close();
        }
        else
        {
            host.Content = BuildPlainText(card.PlainText);
        }
    }

    private RichTextBlock BuildPlainText(string text)
    {
        var rtb = new RichTextBlock { FontFamily = (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["TmFont"], FontSize = 14, LineHeight = 22, IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap };
        foreach (var block in text.Replace("\r\n", "\n").Split("\n\n"))
        {
            var p = new Paragraph();
            var links = HtmlBody.FindLinks(block);
            var pos = 0;
            foreach (var (start, length) in links)
            {
                if (start > pos) p.Inlines.Add(new Run { Text = block[pos..start] });
                var url = block.Substring(start, length);
                var link = new Hyperlink();
                link.Inlines.Add(new Run { Text = url });
                link.Click += (_, _) => _ = PromptAndOpenAsync(url, null);
                p.Inlines.Add(link);
                pos = start + length;
            }
            if (pos < block.Length) p.Inlines.Add(new Run { Text = block[pos..] });
            rtb.Blocks.Add(p);
        }
        return rtb;
    }

    private async Task PromptAndOpenAsync(string uri, string? visibleText)
    {
        var check = LinkSafety.Check(uri, visibleText);
        if (!check.Allowed || check.Uri is null) return;
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(new TextBlock { Text = check.Uri.ToString(), Style = (Style)Application.Current.Resources["TmMono"], TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        if (check.HostDiffersFromText)
            body.Children.Add(new InfoBar { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Warning, Message = "The link text names a different site than the one this link opens." });
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = $"Open link to {check.DisplayHost}?",
            Content = body,
            PrimaryButtonText = "Open",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            RequestedTheme = ActualTheme,
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await Launcher.LaunchUriAsync(check.Uri);
    }

    // ---- attachments ----

    private async void OnAttachmentOpen(object sender, RoutedEventArgs e)
    {
        var (card, att) = AttachmentOf(sender);
        if (card is null || att is null) return;
        try
        {
            if (_ctx.RealMail is null) { await Notify("Attachments are not available in preview mode."); return; }
            var dir = Path.Combine(Path.GetTempPath(), "TaifaMail", "att", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, SafeName(att.Filename));
            await using (var fs = File.Create(path)) await _ctx.RealMail.DownloadAttachmentAsync(card.Detail.Uid, att.PartId, card.Detail.Folder, fs);
            await Launcher.LaunchFileAsync(await StorageFile.GetFileFromPathAsync(path));
        }
        catch (Exception ex) { await Notify("Could not open the attachment. " + ex.Message); }
    }

    private async void OnAttachmentSave(object sender, RoutedEventArgs e)
    {
        var (card, att) = AttachmentOf(sender);
        if (card is null || att is null) return;
        try
        {
            if (_ctx.RealMail is null) { await Notify("Attachments are not available in preview mode."); return; }
            var picker = new FileSavePicker { SuggestedFileName = Path.GetFileNameWithoutExtension(att.Filename) };
            var ext = Path.GetExtension(att.Filename);
            picker.FileTypeChoices.Add(string.IsNullOrEmpty(ext) ? "File" : ext.TrimStart('.').ToUpperInvariant() + " file", new List<string> { string.IsNullOrEmpty(ext) ? "." : ext });
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.MainWindow));
            var file = await picker.PickSaveFileAsync();
            if (file is null) return;
            await using var fs = File.Create(file.Path);
            await _ctx.RealMail.DownloadAttachmentAsync(card.Detail.Uid, att.PartId, card.Detail.Folder, fs);
        }
        catch (Exception ex) { await Notify("Could not save the attachment. " + ex.Message); }
    }

    private (MessageCardVm?, ApiAttachment?) AttachmentOf(object sender)
    {
        var button = (FrameworkElement)sender;
        return (FindCard(button), button.Tag as ApiAttachment);
    }

    private static string SafeName(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return name.Length == 0 ? "attachment" : name;
    }

    private async Task Notify(string message) =>
        await new ContentDialog { XamlRoot = XamlRoot, Title = "Taifa Mail", Content = message, CloseButtonText = "Close", RequestedTheme = ActualTheme }.ShowAsync();

    // ---- helpers ----

    private static MessageCardVm? FindCard(DependencyObject start)
    {
        for (var d = start; d is not null; d = VisualTreeHelper.GetParent(d))
            if (d is FrameworkElement fe && fe.DataContext is MessageCardVm card) return card;
        return null;
    }

    private static T? FindChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T t) return t;
            if (FindChild<T>(child) is { } deep) return deep;
        }
        return null;
    }

    // ---- hooks for the preview driver ----

    public async Task SelectThreadAsync(int index)
    {
        if (index < 0 || index >= Vm.Threads.Count) return;
        ThreadList.SelectedIndex = index;
        await Task.Delay(50);
    }

#if PREVIEW_DATA
    public void Nav_SelectByPath(string path)
    {
        foreach (var item in Nav.MenuItems.OfType<NavigationViewItem>())
            if (item.Tag is ApiFolder f && f.Path == path) { Nav.SelectedItem = item; return; }
    }
#endif
}
