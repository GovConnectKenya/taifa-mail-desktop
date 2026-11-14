using System.Collections.Specialized;
using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using TaifaMail.App.Controls;
using TaifaMail.App.Services;
using TaifaMail.Core.Avatars;
using TaifaMail.Core.Compose;
using TaifaMail.Core.Content;
using TaifaMail.Core.Models;
using TaifaMail.Core.Net;
using TaifaMail.Core.Notifications;
using TaifaMail.Core.Realtime;
using TaifaMail.Core.Security;
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
    private RealtimeClient? _realtime;
    private CancellationTokenSource? _reconcileDelay;
    private System.Threading.Timer? _poll;
    private long? _highWater;
    private bool _connected;
    private Func<Task>? _toastUndo;
    private DispatcherTimer? _toastTimer;
    private Func<Task>? _lastUndo;
    private SettingsWindow? _settings;

    public FrameworkElement TitleBarElement => TitleRow;
    public IEnumerable<FrameworkElement> InteractiveElements => new FrameworkElement[] { PaneToggle, SearchHost, CommandHost };
    public IEnumerable<FrameworkElement> CaptionElements => new FrameworkElement[] { BrandRow };
    private bool _userPane;
    private bool _foldersLoading = true;
    public void SetCaptionInset(double inset) => CaptionInsetColumn.Width = new GridLength(Math.Max(0, inset));

    public ShellPage(ShellContext ctx)
    {
        _ctx = ctx;
        Vm = new MailShellViewModel(ctx.Mail, ctx.ApiBase, ctx.Cache) { OwnAddress = ctx.Me.Address, Compact = ctx.Settings.Density == "compact" };
        InitializeComponent();
        Skeleton.ItemsSource = new int[8];
        ToastPill.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(150) };
        ToastPill.TranslationTransition = new Vector3Transition { Duration = TimeSpan.FromMilliseconds(150) };

        IdentityName.Text = string.IsNullOrWhiteSpace(ctx.Me.DisplayName) ? ctx.Me.Address : ctx.Me.DisplayName;
        IdentityAddress.Text = ctx.Me.Address;
        var (letter, color) = AvatarRule.Placeholder(ctx.Me.Address, ctx.Me.DisplayName);
        IdentityAvatar.Initials = letter;
        IdentityAvatar.FillColor = color;
        if (AvatarRule.TrustedUrl(ctx.Me.AvatarUrl, ctx.ApiBase) is { } own)
            IdentityAvatar.Decision = new AvatarDecision(AvatarKind.Photo, own, ctx.Me.Address);

        Vm.Folders.CollectionChanged += (_, _) => DispatcherQueue.TryEnqueue(RebuildNav);
        Vm.Threads.CollectionChanged += (_, _) => UpdateListState();
        Vm.OpenMessages.CollectionChanged += (_, _) => DispatcherQueue.TryEnqueue(UpdateReaderState);
        Vm.PropertyChanged += OnVmChanged;
        Vm.Notice += (msg, undo) => DispatcherQueue.TryEnqueue(() => ShowToast(msg, undo));
        Vm.ConfirmPermanentDelete = ConfirmDeleteForeverAsync;
        ConfigureBodyView();

        // Windows shortcut table (docs/native/DESIGN_SPEC.md section 9)
        Accel(VirtualKey.F5, VirtualKeyModifiers.None, () => _ = Vm.ReconcileAsync(), allowInText: true);
        Accel(VirtualKey.N, VirtualKeyModifiers.Control, () => OpenCompose(ComposeSeeds.Blank()), allowInText: true);
        Accel(VirtualKey.R, VirtualKeyModifiers.Control, () => ReplyTo(ComposeMode.Reply), allowInText: true);
        Accel(VirtualKey.R, VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, () => ReplyTo(ComposeMode.ReplyAll), allowInText: true);
        Accel(VirtualKey.F, VirtualKeyModifiers.Control, () => ReplyTo(ComposeMode.Forward), allowInText: false);
        Accel(VirtualKey.E, VirtualKeyModifiers.None, () => _ = Vm.ArchiveAsync(Targets()), allowInText: false);
        Accel(VirtualKey.Delete, VirtualKeyModifiers.None, () => _ = Vm.DeleteAsync(Targets()), allowInText: false);
        Accel(VirtualKey.J, VirtualKeyModifiers.Control, () => _ = Vm.IsJunkFolder ? Vm.NotJunkAsync(Targets()) : Vm.JunkAsync(Targets()), allowInText: true);
        Accel(VirtualKey.G, VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, () => _ = Vm.ToggleFlagAsync(Targets()), allowInText: true);
        Accel(VirtualKey.U, VirtualKeyModifiers.Control, () => _ = Vm.SetReadAsync(Targets(), read: false), allowInText: true);
        Accel(VirtualKey.Q, VirtualKeyModifiers.Control, () => _ = Vm.SetReadAsync(Targets(), read: true), allowInText: true);
        Accel(VirtualKey.E, VirtualKeyModifiers.Control, () => FocusSearch(all: false), allowInText: true);
        Accel(VirtualKey.F, VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, () => FocusSearch(all: true), allowInText: true);
        Accel(VirtualKey.Z, VirtualKeyModifiers.Control, () => { if (_lastUndo is { } u) { _lastUndo = null; _ = u(); HideToast(); } }, allowInText: false);
        Accel((VirtualKey)188, VirtualKeyModifiers.Control, OpenSettings, allowInText: true);
        Accel(VirtualKey.B, VirtualKeyModifiers.Control, () => TogglePane(), allowInText: true);
        SizeChanged += (_, e) => AutoPane(e.NewSize.Width);

        Loaded += async (_, _) =>
        {
            try
            {
                UpdateListState();
                UpdateReaderState();
                AutoPane(ActualWidth);
                RebuildNav();
                await Vm.StartAsync();
                _foldersLoading = false;
                RebuildNav();
                try { _siblings = await _ctx.Auth.SwitchableAsync(); } catch (Exception) { }
                await CheckNewMailAsync();
                StartRealtime();
            }
            catch (Exception ex)
            {
                _foldersLoading = false;
                Vm.Error = ex is ApiRequestError or ApiTransportError ? ex.Message : "Something went wrong while loading your mail.";
            }
        };
        Unloaded += async (_, _) => await StopRealtimeAsync();
    }

    // ---- accelerators ----

    private void Accel(VirtualKey key, VirtualKeyModifiers mods, Action action, bool allowInText)
    {
        var a = new KeyboardAccelerator { Key = key, Modifiers = mods };
        a.Invoked += (_, e) =>
        {
            if (!allowInText && TextIsFocused()) return;
            action();
            e.Handled = true;
        };
        KeyboardAccelerators.Add(a);
    }

    private bool TextIsFocused() => FocusManager.GetFocusedElement(XamlRoot) is TextBox or PasswordBox or RichEditBox or AutoSuggestBox;

    private void FocusSearch(bool all)
    {
        Vm.SearchAllFolders = all;
        SearchBox.PlaceholderText = all ? "Search all folders" : "Search in this folder";
        SearchBox.Focus(FocusState.Programmatic);
        SearchBox.SelectAll();
    }

    /// <summary>The rows an action applies to: the multi selection, else the open conversation.</summary>
    private IReadOnlyList<ThreadRow> Targets()
    {
        var sel = ThreadList.SelectedItems.OfType<ThreadRow>().ToList();
        if (sel.Count > 0) return sel;
        return Vm.SelectedThread is { } r ? new[] { r } : Array.Empty<ThreadRow>();
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
                case nameof(MailShellViewModel.Error):
                case nameof(MailShellViewModel.Total):
                    UpdateListState();
                    break;
                case nameof(MailShellViewModel.TotalUnread):
                    UpdateBadge();
                    break;
                case nameof(MailShellViewModel.Quota):
                    UpdateQuota();
                    break;
                case nameof(MailShellViewModel.OpenLoading):
                case nameof(MailShellViewModel.OpenError):
                case nameof(MailShellViewModel.SelectedThread):
                case nameof(MailShellViewModel.HasMoreOlder):
                case nameof(MailShellViewModel.OpenUnavailableOffline):
                    UpdateReaderState();
                    break;
            }
        });
    }

    private void UpdateQuota()
    {
        if (Vm.Quota is not { } q || !Nav.IsPaneOpen) { QuotaPanel.Visibility = Visibility.Collapsed; return; }
        QuotaPanel.Visibility = Visibility.Visible;
        QuotaBar.Value = q.Percent ?? (q.LimitBytes is > 0 ? 100.0 * q.UsedBytes / q.LimitBytes.Value : 0);
        QuotaText.Text = q.LimitBytes is { } lim ? $"{ApiAttachmentExt.Human(q.UsedBytes)} of {ApiAttachmentExt.Human(lim)} used" : $"{ApiAttachmentExt.Human(q.UsedBytes)} used";
    }

    private void UpdateListState()
    {
        var folder = Vm.SelectedFolder;
        ListTitle.Text = Vm.Searching ? $"Search: {Vm.SearchText}" : (folder?.Name ?? "");
        ListCounts.Text = Vm.Searching ? $"{Vm.Threads.Count:N0} results" : Fmt.Unreadline(Vm.Total, folder?.Unseen ?? 0);
        var noRows = Vm.Threads.Count == 0;
        var failed = noRows && !Vm.Loading && !string.IsNullOrEmpty(Vm.Error);
        Skeleton.Visibility = noRows && Vm.Loading ? Visibility.Visible : Visibility.Collapsed;
        ErrorState.Visibility = failed ? Visibility.Visible : Visibility.Collapsed;
        ErrorTitle.Text = $"Couldn't load {folder?.Name ?? "this folder"}";
        ErrorMessage.Text = Vm.Error ?? "";
        ErrorBar.IsOpen = !noRows && !string.IsNullOrEmpty(Vm.Error);
        var empty = noRows && !Vm.Loading && !failed && folder is not null;
        EmptyState.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        EmptyLogo.Visibility = empty && folder?.Path == "INBOX" && !Vm.Searching ? Visibility.Visible : Visibility.Collapsed;
        EmptyHint.Text = "No messages match this view.";
    }

    private void UpdateReaderState()
    {
        var hasCards = Vm.OpenMessages.Count > 0;
        var loading = Vm.SelectedThread is not null && Vm.OpenLoading && !hasCards;
        var failed = Vm.SelectedThread is not null && !Vm.OpenLoading && !hasCards && !string.IsNullOrEmpty(Vm.OpenError);
        ReaderGrid.Visibility = hasCards ? Visibility.Visible : Visibility.Collapsed;
        ReaderSkeleton.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        ReaderError.Visibility = failed ? Visibility.Visible : Visibility.Collapsed;
        var multi = ThreadList.SelectedItems.Count > 1;
        ReaderEmpty.Visibility = !hasCards && !loading && !failed ? Visibility.Visible : Visibility.Collapsed;
        ReaderEmptyTitle.Text = multi ? $"{ThreadList.SelectedItems.Count} conversations selected" : "Select a conversation";
        ReaderEmptyHint.Text = multi ? "Use the toolbar above the list to act on all of them." : "Choose a message from the list to read it here.";
        ReaderErrorTitle.Text = Vm.OpenUnavailableOffline ? "Not available offline" : "Couldn't load this message";
        ReaderErrorText.Text = Vm.OpenUnavailableOffline ? "This message has not been opened on this computer yet." : Vm.OpenError ?? "";
        ReadBar.IsOpen = hasCards && !string.IsNullOrEmpty(Vm.OpenError);
        EarlierPill.Visibility = hasCards && Vm.HasMoreOlder ? Visibility.Visible : Visibility.Collapsed;
        EarlierText.Text = Vm.EarlierCount > 0 ? $"Show earlier messages ({Vm.EarlierCount} more)" : "Show earlier messages";
        if (hasCards) { ReaderSubject.Text = Vm.OpenMessages[^1].Subject; PositionText.Text = Vm.OpenPosition; }
    }

    // ---- sidebar ----

    private const double CompactBelowDip = 1100;

    private void AutoPane(double width)
    {
        if (_userPane || width <= 0) return;
        var wantOpen = width >= CompactBelowDip;
        if (Nav.IsPaneOpen != wantOpen) Nav.IsPaneOpen = wantOpen;
    }

    private void TogglePane() { _userPane = true; Nav.IsPaneOpen = !Nav.IsPaneOpen; }
    private void OnPaneToggle(object sender, RoutedEventArgs e) => TogglePane();
    private void OnPaneClosing(NavigationView sender, NavigationViewPaneClosingEventArgs args) => DispatcherQueue.TryEnqueue(ApplyPaneState);
    private void OnPaneStateChanged(NavigationView sender, object args) => DispatcherQueue.TryEnqueue(ApplyPaneState);

    /// <summary>Icons only in the compact rail (66 wide, like the webmail), full rows when it is open.</summary>
    private void ApplyPaneState()
    {
        var open = Nav.IsPaneOpen;
        BrandText.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        ComposeLabel.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        IdentityText.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        IdentityChevron.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        QuotaPanel.Visibility = open && Vm.Quota is not null ? Visibility.Visible : Visibility.Collapsed;
        RebuildNav();
        App.MainWindow?.RefreshChrome();
    }

    private void RebuildNav()
    {
        _buildingNav = true;
        try
        {
            Nav.MenuItems.Clear();
            if (Vm.Folders.Count == 0 && _foldersLoading)
            {
                for (var i = 0; i < 6; i++)
                    Nav.MenuItems.Add(new NavigationViewItem { Content = new SkeletonBar { Height = 14, Radius = 4, Margin = new Thickness(4, 0, 4, 0) }, IsHitTestVisible = false, MinHeight = 36, Height = 36, SelectsOnInvoked = false });
                return;
            }
            var addedHeader = false;
            NavigationViewItem? selected = null;
            foreach (var f in Vm.Folders)
            {
                if (Fmt.IconFor(f) == "folder" && !addedHeader && Nav.IsPaneOpen)
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
        finally { _buildingNav = false; RestyleAll(); }
    }

    private static string Esc(string s) => System.Security.SecurityElement.Escape(s) ?? "";

    private NavigationViewItem BuildFolderItem(ApiFolder f)
    {
        var open = Nav.IsPaneOpen;
        var badge = Fmt.FolderBadge(f);
        var unreadCount = f.SpecialUse is { } su && su.Contains("draft", StringComparison.OrdinalIgnoreCase) ? 0 : f.Unseen ?? 0;
        var unread = unreadCount > 0;
        var countBrush = unread ? "{ThemeResource TmAccentInkBrush}" : "{ThemeResource TmText3Brush}";
        var countFont = unread ? "{StaticResource TmMonoSemi}" : "{StaticResource TmMono}";
        var baseFont = unread ? "{StaticResource TmFontSemi}" : "{StaticResource TmFont}";
        var name = Esc(f.Name);
        var xaml = $@"<Grid xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' xmlns:ctl='using:TaifaMail.App.Controls' ColumnSpacing='12' Height='36' Background='Transparent'>
  <Grid.ColumnDefinitions><ColumnDefinition Width='Auto'/><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>
  <ctl:IconView x:Name='Icon' IconName='{Fmt.IconFor(f)}' Size='15' VerticalAlignment='Center' Foreground='{{ThemeResource TmText2Brush}}' HorizontalAlignment='Center'/>
  <Grid Grid.Column='1' x:Name='Labels' Visibility='{(open ? "Visible" : "Collapsed")}'>
    <TextBlock x:Name='Muted' Text='{name}' FontFamily='{baseFont}' FontSize='13' Foreground='{{ThemeResource TmText2Brush}}' VerticalAlignment='Center' TextTrimming='CharacterEllipsis'/>
    <TextBlock x:Name='Hover' Text='{name}' FontFamily='{baseFont}' FontSize='13' Foreground='{{ThemeResource TmTextBrush}}' VerticalAlignment='Center' TextTrimming='CharacterEllipsis' Visibility='Collapsed'/>
    <TextBlock x:Name='Active' Text='{name}' FontFamily='{{StaticResource TmFontSemi}}' FontSize='13' Foreground='{{ThemeResource TmAccentInkBrush}}' VerticalAlignment='Center' TextTrimming='CharacterEllipsis' Visibility='Collapsed'/>
  </Grid>
  <TextBlock Grid.Column='2' Text='{Esc(badge)}' FontFamily='{countFont}' FontSize='11' Foreground='{countBrush}' VerticalAlignment='Center' Visibility='{(open ? "Visible" : "Collapsed")}'/>
</Grid>";
        var content = (Grid)XamlReader.Load(xaml);
        var item = new NavigationViewItem { Content = content, Tag = f, MinHeight = 36, Height = 36, CornerRadius = new CornerRadius(8), Margin = new Thickness(8, 1, 8, 1) };
        item.PointerEntered += (_, _) => RestyleItem(item, hover: true);
        item.PointerExited += (_, _) => RestyleItem(item, hover: false);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, badge.Length > 0 ? $"{f.Name}, {badge}" : f.Name);
        return item;
    }

    private static void RestyleItem(NavigationViewItem item, bool hover)
    {
        if (item.Content is not Grid g) return;
        var active = item.IsSelected;
        if (g.FindName("Muted") is not TextBlock muted || g.FindName("Hover") is not TextBlock hov || g.FindName("Active") is not TextBlock act) return;
        act.Visibility = active ? Visibility.Visible : Visibility.Collapsed;
        hov.Visibility = !active && hover ? Visibility.Visible : Visibility.Collapsed;
        muted.Visibility = !active && !hover ? Visibility.Visible : Visibility.Collapsed;
    }

    private void RestyleAll()
    {
        foreach (var item in Nav.MenuItems.OfType<NavigationViewItem>()) RestyleItem(item, hover: false);
    }

    private void OnFolderSelected(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        RestyleAll();
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
        var settings = new MenuFlyoutItem { Text = "Settings", KeyboardAcceleratorTextOverride = "Ctrl+," };
        settings.Click += (_, _) => OpenSettings();
        IdentityFlyout.Items.Add(settings);
        IdentityFlyout.Items.Add(new MenuFlyoutSeparator());
        var signOut = (MenuFlyoutItem)XamlReader.Load("<MenuFlyoutItem xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Text='Sign out' Foreground='{ThemeResource TmDangerFgBrush}'/>");
        signOut.Click += async (_, _) => await _ctx.SignOut();
        IdentityFlyout.Items.Add(signOut);
    }

    private void OnOpenSettings(object sender, RoutedEventArgs e) => OpenSettings();

    private void OpenSettings()
    {
        if (_settings is not null) { _settings.Activate(); return; }
        _settings = new SettingsWindow(_ctx, density => { Vm.Compact = density == "compact"; }, UpdateBadge);
        _settings.Closed += (_, _) => _settings = null;
        _settings.Activate();
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
        BulkBar.Visibility = count > 1 ? Visibility.Visible : Visibility.Collapsed;
        ListHeader.Visibility = count > 1 ? Visibility.Collapsed : Visibility.Visible;
        BulkCount.Text = $"{count} selected";
        if (count == 1 && ThreadList.SelectedItem is ThreadRow row && !ReferenceEquals(Vm.SelectedThread, row)) _ = Vm.OpenAsync(row);
        UpdateReaderState();
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => _ = Vm.ReconcileAsync();
    private void OnRetryOpen(object sender, RoutedEventArgs e) { if (Vm.SelectedThread is { } r) _ = Vm.OpenAsync(r); }
    private void OnShowEarlier(object sender, TappedRoutedEventArgs e) => _ = Vm.LoadOlderAsync();

    private void OnBulkArchive(object sender, RoutedEventArgs e) => _ = Vm.ArchiveAsync(Targets());
    private void OnBulkDelete(object sender, RoutedEventArgs e) => _ = Vm.DeleteAsync(Targets());
    private void OnBulkRead(object sender, RoutedEventArgs e) => _ = Vm.SetReadAsync(Targets(), read: true);
    private void OnBulkStar(object sender, RoutedEventArgs e) => _ = Vm.ToggleFlagAsync(Targets());

    // hover actions and context menu
    private static ThreadRow? RowOf(object sender) => (sender as FrameworkElement)?.DataContext as ThreadRow;
    private void OnRowPointerEntered(object sender, PointerRoutedEventArgs e) => SetActions(sender, Visibility.Visible);
    private void OnRowPointerExited(object sender, PointerRoutedEventArgs e) => SetActions(sender, Visibility.Collapsed);
    private static void SetActions(object sender, Visibility v)
    {
        if (sender is Grid g && g.Children.OfType<Border>().FirstOrDefault(b => b.Name == "RowActions") is { } b) b.Visibility = v;
    }
    private void OnRowArchive(object sender, RoutedEventArgs e) { if (RowOf(sender) is { } r) _ = Vm.ArchiveAsync(new[] { r }); }
    private void OnRowDelete(object sender, RoutedEventArgs e) { if (RowOf(sender) is { } r) _ = Vm.DeleteAsync(new[] { r }); }
    private void OnRowToggleRead(object sender, RoutedEventArgs e) { if (RowOf(sender) is { } r) _ = Vm.SetReadAsync(new[] { r }, read: r.Unread); }
    private void OnRowStar(object sender, RoutedEventArgs e) { if (RowOf(sender) is { } r) _ = Vm.ToggleFlagAsync(new[] { r }); }

    private static ThreadRow? RowFrom(DependencyObject? start)
    {
        for (var d = start; d is not null; d = VisualTreeHelper.GetParent(d))
            if (d is FrameworkElement fe && fe.DataContext is ThreadRow r) return r;
        return null;
    }

    /// <summary>Right click, Shift+F10 and the Menu key all arrive here; the keyboard uses the selected row.</summary>
    private void OnListContextRequested(UIElement sender, ContextRequestedEventArgs args)
    {
        var row = RowFrom(args.OriginalSource as DependencyObject) ?? ThreadList.SelectedItem as ThreadRow;
        if (row is null) return;
        var rows = ThreadList.SelectedItems.OfType<ThreadRow>().Contains(row) ? ThreadList.SelectedItems.OfType<ThreadRow>().ToList() : new List<ThreadRow> { row };
        var menu = new MenuFlyout();
        void Add(string text, Action act, string? accel = null)
        {
            var mi = new MenuFlyoutItem { Text = text };
            if (accel is not null) mi.KeyboardAcceleratorTextOverride = accel;
            mi.Click += (_, _) => act();
            menu.Items.Add(mi);
        }
        if (rows.Count == 1) { Add("Reply", () => { _ = Vm.OpenAsync(row); ReplyTo(ComposeMode.Reply); }, "Ctrl+R"); menu.Items.Add(new MenuFlyoutSeparator()); }
        Add("Archive", () => _ = Vm.ArchiveAsync(rows), "E");
        Add("Delete", () => _ = Vm.DeleteAsync(rows), "Del");
        if (Vm.IsJunkFolder) Add("Not junk", () => _ = Vm.NotJunkAsync(rows), "Ctrl+J");
        else Add("Mark as junk", () => _ = Vm.JunkAsync(rows), "Ctrl+J");
        menu.Items.Add(new MenuFlyoutSeparator());
        Add(rows.Any(r => r.Unread) ? "Mark as read" : "Mark as unread", () => _ = Vm.SetReadAsync(rows, read: rows.Any(r => r.Unread)), rows.Any(r => r.Unread) ? "Ctrl+Q" : "Ctrl+U");
        Add(rows.All(r => r.Flagged) ? "Remove star" : "Star", () => _ = Vm.ToggleFlagAsync(rows), "Ctrl+Shift+G");
        var move = new MenuFlyoutSubItem { Text = "Move to" };
        foreach (var f in Vm.Folders.Where(f => f.Path != Vm.SelectedFolder?.Path))
        {
            var mi = new MenuFlyoutItem { Text = f.Name };
            var path = f.Path;
            mi.Click += (_, _) => _ = Vm.MoveToAsync(rows, path);
            move.Items.Add(mi);
        }
        menu.Items.Add(move);
        if (args.TryGetPosition(ThreadList, out var pos)) menu.ShowAt(ThreadList, new FlyoutShowOptions { Position = pos });
        else menu.ShowAt(ThreadList);
        args.Handled = true;
    }

    // ---- reader toolbar ----

    private IReadOnlyList<ThreadRow> Open() => Vm.SelectedThread is { } r ? new[] { r } : Array.Empty<ThreadRow>();
    private void OnReaderArchive(object sender, RoutedEventArgs e) => _ = Vm.ArchiveAsync(Open());
    private void OnReaderJunk(object sender, RoutedEventArgs e) => _ = Vm.IsJunkFolder ? Vm.NotJunkAsync(Open()) : Vm.JunkAsync(Open());
    private void OnReaderDelete(object sender, RoutedEventArgs e) => _ = Vm.DeleteAsync(Open());
    private void OnReaderUnread(object sender, RoutedEventArgs e) => _ = Vm.SetReadAsync(Open(), read: false);
    private void OnReaderStar(object sender, RoutedEventArgs e) => _ = Vm.ToggleFlagAsync(Open());

    private void OnMoveOpening(object? sender, object e)
    {
        MoveFlyout.Items.Clear();
        foreach (var f in Vm.Folders.Where(f => f.Path != Vm.SelectedFolder?.Path))
        {
            var mi = new MenuFlyoutItem { Text = f.Name };
            var path = f.Path;
            mi.Click += (_, _) => _ = Vm.MoveToAsync(Open(), path);
            MoveFlyout.Items.Add(mi);
        }
    }

    private void OnNewer(object sender, RoutedEventArgs e) => GoTo(Vm.Neighbour(-1));
    private void OnOlder(object sender, RoutedEventArgs e) => GoTo(Vm.Neighbour(+1));
    private void GoTo(ThreadRow? row) { if (row is not null) { ThreadList.SelectedItem = row; ThreadList.ScrollIntoView(row); } }

    // ---- compose, reply, forward ----

    private void OnCompose(object sender, RoutedEventArgs e) => OpenCompose(ComposeSeeds.Blank());
    private void OnReply(object sender, RoutedEventArgs e) => ReplyTo(ComposeMode.Reply);
    private void OnReplyAll(object sender, RoutedEventArgs e) => ReplyTo(ComposeMode.ReplyAll);
    private void OnForward(object sender, RoutedEventArgs e) => ReplyTo(ComposeMode.Forward);

    private void ReplyTo(ComposeMode mode)
    {
        if (Vm.OpenMessages.Count == 0) return;
        OpenCompose(ComposeSeeds.For(mode, Vm.OpenMessages[^1].Detail, _ctx.Me.Address));
    }

    private async void OpenCompose(ComposeSeed seed)
    {
        try { await OpenComposeCoreAsync(seed); }
        catch (Exception ex) { ShowToast("Could not open the compose window. " + ex.Message, null); }
    }

    private async Task OpenComposeCoreAsync(ComposeSeed seed)
    {
        if (_ctx.RealMail is null) { ShowToast("Compose is not available in preview mode.", null); return; }
        if (Vm.Offline) { ShowToast(MailShellViewModel.OfflineTip, null); return; }
        var cvm = new TaifaMail.Core.Compose.ComposeViewModel(new ComposeApi(_ctx.RealMail), _ctx.Me.Address, seed);
        var threadAddresses = Vm.OpenMessages.SelectMany(c => new[] { c.AvatarAddress }.Concat(c.Detail.To ?? new()).Concat(c.Detail.Cc ?? new())).ToList();
        var win = new ComposeWindow(cvm, _ctx, threadAddresses, sent => DispatcherQueue.TryEnqueue(() => ShowToast(sent, null)));
        win.Activate();
        await cvm.StageForwardAttachmentsAsync();
    }

    // ---- toast ----

    private void ShowToast(string message, Func<Task>? undo)
    {
        _toastUndo = undo;
        _lastUndo = undo;
        ToastText.Text = message;
        ToastUndo.Visibility = undo is null ? Visibility.Collapsed : Visibility.Visible;
        ToastPill.Visibility = Visibility.Visible;
        ToastPill.Opacity = 1;
        ToastPill.Translation = new System.Numerics.Vector3(0, 0, 32);
        _toastTimer?.Stop();
        _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(8) };
        _toastTimer.Tick += (_, _) => HideToast();
        _toastTimer.Start();
    }

    private async void HideToast()
    {
        _toastTimer?.Stop();
        ToastPill.Opacity = 0;
        ToastPill.Translation = new System.Numerics.Vector3(0, 12, 0);
        await Task.Delay(180);
        if (ToastPill.Opacity == 0) ToastPill.Visibility = Visibility.Collapsed;
        _lastUndo = null;
    }

    private async void OnToastUndo(object sender, RoutedEventArgs e)
    {
        var undo = _toastUndo;
        HideToast();
        try { if (undo is not null) await undo(); }
        catch (Exception) { ShowToast("Could not undo that", null); }
    }

    private void OnToastClose(object sender, RoutedEventArgs e) => HideToast();
    private void OnToastEntered(object sender, PointerRoutedEventArgs e) => _toastTimer?.Stop();
    private void OnToastExited(object sender, PointerRoutedEventArgs e) { if (ToastPill.Visibility == Visibility.Visible) _toastTimer?.Start(); }

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
        if (e.Key == VirtualKey.Escape)
        {
            SearchBox.Text = "";
            Vm.SearchAllFolders = false;
            SearchBox.PlaceholderText = "Search in this folder";
            ThreadList.Focus(FocusState.Programmatic);
            e.Handled = true;
        }
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
        App.MainWindow?.RefreshChrome();
    }

    private void OnSplitterEntered(object sender, PointerRoutedEventArgs e) => SplitterLine.Width = 3;
    private void OnSplitterExited(object sender, PointerRoutedEventArgs e) { if (!_draggingSplitter) SplitterLine.Width = 1; }

    private void OnSplitterKeyDown(object sender, KeyRoutedEventArgs e)
    {
        var delta = e.Key == VirtualKey.Left ? -16 : e.Key == VirtualKey.Right ? 16 : 0;
        if (delta == 0) return;
        ListColumn.Width = new GridLength(Math.Clamp(ListColumn.ActualWidth + delta, 300, 480));
        e.Handled = true;
    }

    // ---- reader messages ----

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
            web.FailedToStart += () => DispatcherQueue.TryEnqueue(() => host.Content = BuildPlainText(card));
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
            host.Content = BuildPlainText(card);
        }
    }

    private RichTextBlock BuildPlainText(MessageCardVm card)
    {
        var text = card.PlainText;
        var rtb = new RichTextBlock { FontFamily = (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["TmFont"], FontSize = 14, LineHeight = 22, IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap };
        foreach (var block in text.Replace("\r\n", "\n").Split("\n\n"))
        {
            var p = new Paragraph();
            // a message whose links are disabled by the server shows URLs as plain text, never as links
            var links = card.LinksDisabled ? Array.Empty<(int Start, int Length)>() : HtmlBody.FindLinks(block);
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
        body.Children.Add(new TextBlock { Text = check.Uri.ToString(), Style = (Style)Application.Current.Resources["TmMonoText"], TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        if (check.ShowBothForms)
            body.Children.Add(new TextBlock { Text = $"Host: {check.DisplayHost}\nPunycode: {check.Host}", Style = (Style)Application.Current.Resources["TmMonoText"], TextWrapping = TextWrapping.Wrap });
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

    private static string Origin(string apiBase) => Uri.TryCreate(apiBase, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : apiBase;

    /// <summary>Mark of the Web: the file is flagged as downloaded from the internet so Windows applies SmartScreen and Office protections.</summary>
    private void WriteMotw(string path)
    {
        try { File.WriteAllText(path + ":Zone.Identifier", AttachmentSafety.ZoneIdentifier(Origin(_ctx.ApiBase))); }
        catch (Exception) { /* not NTFS: nothing to mark */ }
    }

    private async void OnAttachmentOpen(object sender, RoutedEventArgs e)
    {
        try
        {
            var (card, att) = AttachmentOf(sender);
            if (card is null || att is null) return;
            if (_ctx.RealMail is null) { await Notify("Attachments are not available in preview mode."); return; }
            if (AttachmentSafety.IsRisky(att.Filename))
            {
                // executables, scripts, containers and macro documents are never opened straight from the app
                var d = new ContentDialog
                {
                    XamlRoot = XamlRoot, Title = "This file type is not opened from here",
                    Content = $"{AttachmentSafety.SafeName(att.Filename)} can run code or contain macros. Save it and scan it before you open it.",
                    PrimaryButtonText = "Save", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close, RequestedTheme = ActualTheme,
                };
                if (await d.ShowAsync() == ContentDialogResult.Primary) await SaveAttachmentAsync(card, att);
                return;
            }
            var dir = Path.Combine(AppServices.AttachmentTempDir, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, AttachmentSafety.SafeName(att.Filename));
            await using (var fs = File.Create(path)) await _ctx.RealMail.DownloadAttachmentAsync(card.Detail.Uid, att.PartId, card.Detail.Folder, fs);
            WriteMotw(path);
            await Launcher.LaunchFileAsync(await StorageFile.GetFileFromPathAsync(path));
        }
        catch (Exception ex) { await Notify("Could not open the attachment. " + ex.Message); }
    }

    private async void OnAttachmentSave(object sender, RoutedEventArgs e)
    {
        try
        {
            var (card, att) = AttachmentOf(sender);
            if (card is null || att is null) return;
            await SaveAttachmentAsync(card, att);
        }
        catch (Exception ex) { await Notify("Could not save the attachment. " + ex.Message); }
    }

    private async Task SaveAttachmentAsync(MessageCardVm card, ApiAttachment att)
    {
        if (_ctx.RealMail is null) { await Notify("Attachments are not available in preview mode."); return; }
        var safe = AttachmentSafety.SafeName(att.Filename);
        var picker = new FileSavePicker { SuggestedFileName = Path.GetFileNameWithoutExtension(safe) };
        var ext = Path.GetExtension(safe);
        picker.FileTypeChoices.Add(string.IsNullOrEmpty(ext) ? "File" : ext.TrimStart('.').ToUpperInvariant() + " file", new List<string> { string.IsNullOrEmpty(ext) ? "." : ext });
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.MainWindow));
        var file = await picker.PickSaveFileAsync();
        if (file is null) return;
        await using (var fs = File.Create(file.Path)) await _ctx.RealMail.DownloadAttachmentAsync(card.Detail.Uid, att.PartId, card.Detail.Folder, fs);
        WriteMotw(file.Path);
    }

    private (MessageCardVm?, ApiAttachment?) AttachmentOf(object sender)
    {
        var button = (FrameworkElement)sender;
        return (FindCard(button), button.Tag as ApiAttachment);
    }

    private async Task Notify(string message) =>
        await new ContentDialog { XamlRoot = XamlRoot, Title = "Taifa Mail", Content = message, CloseButtonText = "Close", RequestedTheme = ActualTheme }.ShowAsync();

    // ---- realtime, toasts, badge ----

    private void StartRealtime()
    {
        if (_ctx.Api is null || _realtime is not null) return;
        _ctx.Notifications?.Register(DispatcherQueue);
        if (_ctx.Notifications is { } n) n.ThreadRequested += OnToastActivated;
        _realtime = new RealtimeClient(_ctx.Api);
        _realtime.EventReceived += e =>
        {
            if (!e.IsFor(_ctx.Mail.MailboxId) || e.Kind is RealtimeKind.Connected or RealtimeKind.Pong) return;
            ScheduleReconcile();
        };
        _realtime.ConnectionChanged += up => { _connected = up; DispatcherQueue.TryEnqueue(() => { if (up) Vm.Offline = false; }); };
        _realtime.Reconnected += () => ScheduleReconcile();
        _realtime.Start();
        _poll = new System.Threading.Timer(_ => { if (!_connected) ScheduleReconcile(); }, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));
    }

    private async Task StopRealtimeAsync()
    {
        _poll?.Dispose();
        if (_ctx.Notifications is { } n) n.ThreadRequested -= OnToastActivated;
        if (_realtime is { } rt) { _realtime = null; await rt.StopAsync(); }
    }

    private void ScheduleReconcile()
    {
        _reconcileDelay?.Cancel();
        var cts = _reconcileDelay = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(500, cts.Token); } catch (OperationCanceledException) { return; }
            DispatcherQueue.TryEnqueue(async () =>
            {
                if (cts.IsCancellationRequested || Vm.Searching) return;
                await Vm.ReconcileAsync();
                await CheckNewMailAsync();
            });
        });
    }

    private async Task CheckNewMailAsync()
    {
        try
        {
            var page = await _ctx.Mail.ConversationsAsync("INBOX", 20, 0);
            var latest = page.Items.Select(i => i.Latest).ToList();
            var decision = NotifyPolicy.Decide(latest, _highWater, _ctx.Me.Address, _ctx.Settings.NewMailAlerts, _ctx.Settings.ShowNotificationPreview);
            _highWater = decision.HighWater;
            if (!_ctx.IsPreview)
                foreach (var t in NotifyPolicy.Collapse(decision.Toasts)) _ctx.Notifications?.Show(t);
        }
        catch (Exception e) when (e is ApiRequestError or ApiTransportError) { }
        UpdateBadge();
    }

    private void UpdateBadge()
    {
        if (_ctx.Notifications is null || _ctx.IsPreview || App.MainWindow is null) return;
        var label = NotifyPolicy.BadgeLabel(Vm.TotalUnread, _ctx.Settings.TaskbarBadge);
        _ctx.Notifications.SetBadge(WinRT.Interop.WindowNative.GetWindowHandle(App.MainWindow), label);
    }

    private async void OnToastActivated(string folder, long uid)
    {
        try { await OpenFromToastAsync(folder, uid); }
        catch (Exception) { }
    }

    private async Task OpenFromToastAsync(string folder, long uid)
    {
        var inbox = Vm.Folders.FirstOrDefault(f => f.Path == folder) ?? Vm.Folders.FirstOrDefault(f => f.Path == "INBOX");
        if (inbox is null) return;
        if (Vm.SelectedFolder?.Path != inbox.Path || Vm.Searching) { SearchBox.Text = ""; await Vm.LoadFolderAsync(inbox); }
        else await Vm.ReconcileAsync();
        var row = Vm.Threads.FirstOrDefault(t => t.Uids.Contains(uid));
        if (row is null) return;
        ThreadList.SelectedItem = row;
        if (!ReferenceEquals(Vm.SelectedThread, row)) await Vm.OpenAsync(row);
    }

    // ---- body view wiring, confirmations ----

    private (string Token, DateTimeOffset Expires)? _capability;

    /// <summary>Gives the body viewer what it needs for the server image proxy: origin, mailbox, a capability and a cookie authenticated fetch.</summary>
    private void ConfigureBodyView()
    {
        BodyWebView.ApiBase = _ctx.ApiBase;
        BodyWebView.MailboxId = _ctx.Mail.MailboxId;
        BodyWebView.ProxyFetcher = _ctx.Api is { } api ? url => api.TryGetBytesAsync(url) : null;
        BodyWebView.CapabilityProvider = _ctx.RealMail is { } mail ? async () =>
        {
            try
            {
                if (_capability is { } c && c.Expires > DateTimeOffset.UtcNow.AddMinutes(5)) return c.Token;
                var cap = await mail.ImageProxyCapabilityAsync();
                _capability = (cap.Token, DateTimeOffset.TryParse(cap.ExpiresAt, out var exp) ? exp : DateTimeOffset.UtcNow.AddMinutes(10));
                return cap.Token;
            }
            catch (Exception) { return null; }
        } : null;
    }

    private async Task<bool> ConfirmDeleteForeverAsync(int count)
    {
        var d = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "Delete forever?",
            Content = count == 1 ? "This conversation will be deleted permanently. This cannot be undone." : $"These {count} conversations will be deleted permanently. This cannot be undone.",
            PrimaryButtonText = "Delete forever",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            RequestedTheme = ActualTheme,
        };
        return await d.ShowAsync() == ContentDialogResult.Primary;
    }

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
