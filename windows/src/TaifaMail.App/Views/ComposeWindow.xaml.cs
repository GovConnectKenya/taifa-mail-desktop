using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using TaifaMail.App.Controls;
using TaifaMail.App.Services;
using TaifaMail.Core.Compose;
using TaifaMail.Core.Net;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;

namespace TaifaMail.App.Views;

/// <summary>The compose window (640 by 560): recipients, rich text editor, attachments, server drafts, send.</summary>
public sealed partial class ComposeWindow : Window
{
    private readonly ComposeViewModel _vm;
    private readonly ShellContext _ctx;
    private readonly Action<string> _onSent;
    private (string Html, string Text) _snapshot = ("", "");
    private bool _done;

    public ComposeWindow(ComposeViewModel vm, ShellContext ctx, IEnumerable<string> threadAddresses, Action<string> onSent)
    {
        _vm = vm;
        _ctx = ctx;
        _onSent = onSent;
        InitializeComponent();
        if (MicaController.IsSupported()) SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new SizeInt32(640, 560));
        var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "taifa.ico");
        if (File.Exists(ico)) AppWindow.SetIcon(ico);
        Root.RequestedTheme = ctx.Settings.Theme switch { "light" => ElementTheme.Light, "dark" => ElementTheme.Dark, _ => ElementTheme.Default };
        var title = vm.Seed.Mode switch { ComposeMode.Reply => "Reply", ComposeMode.ReplyAll => "Reply all", ComposeMode.Forward => "Forward", _ => "New message" };
        Title = title;
        TitleText.Text = title;
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleRow);

        FromText.Text = vm.From;
        var thread = threadAddresses.ToList();
        var to = new RecipientBox(vm, vm.To, thread, "To");
        ToHost.Content = to;
        CcHost.Content = new RecipientBox(vm, vm.Cc, thread, "Cc");
        BccHost.Content = new RecipientBox(vm, vm.Bcc, thread, "Bcc");
        if (vm.ShowCc) { CcRow.Visibility = Visibility.Visible; CcLink.Visibility = Visibility.Collapsed; }
        SubjectBox.Text = vm.Subject;
        AttachmentStrip.ItemsSource = vm.Attachments;
        vm.Attachments.CollectionChanged += (_, _) => AttachmentStrip.Visibility = vm.Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        vm.BodyProvider = () => _snapshot;
        vm.PropertyChanged += (_, e) => DispatcherQueue.TryEnqueue(() => OnVmChanged(e.PropertyName));

        var send = new KeyboardAccelerator { Key = VirtualKey.Enter, Modifiers = VirtualKeyModifiers.Control };
        send.Invoked += (_, e) => { OnSend(this, new RoutedEventArgs()); e.Handled = true; };
        Root.KeyboardAccelerators.Add(send);
        var close = new KeyboardAccelerator { Key = VirtualKey.W, Modifiers = VirtualKeyModifiers.Control };
        close.Invoked += (_, e) => { Close(); e.Handled = true; };
        Root.KeyboardAccelerators.Add(close);

        AppWindow.Closing += async (_, e) =>
        {
            if (_done) return;
            e.Cancel = true;
            _done = true;
            Capture();
            await _vm.SaveOnCloseAsync();
            Close();
        };

        Root.Loaded += async (_, _) =>
        {
            await PrefillAsync();
            (vm.To.Count == 0 ? to : null)?.FocusInput();
            if (vm.To.Count > 0) Editor.Focus(FocusState.Programmatic);
        };
    }

    private async Task PrefillAsync()
    {
        var signature = "";
        try
        {
            if (_ctx.Api is not null)
            {
                var blocks = await new SettingsApi(_ctx.Api).BlocksAsync();
                var sig = blocks.Signatures.FirstOrDefault(b => b.IsDefault) ?? blocks.Signatures.FirstOrDefault();
                if (sig is not null) signature = !string.IsNullOrWhiteSpace(sig.Text) ? sig.Text! : TaifaMail.Core.Content.HtmlText.Strip(sig.Html);
            }
        }
        catch (Exception) { }
        var text = "\r\r" + (signature.Length > 0 ? "-- \r" + signature.Replace("\r\n", "\r").Replace("\n", "\r") : "");
        Editor.Document.SetText(TextSetOptions.None, text);
        Editor.Document.Selection.SetRange(0, 0);
        Capture();
    }

    private void OnVmChanged(string? name)
    {
        switch (name)
        {
            case nameof(ComposeViewModel.Sending):
                SendLabel.Visibility = _vm.Sending ? Visibility.Collapsed : Visibility.Visible;
                SendingLabel.Visibility = _vm.Sending ? Visibility.Visible : Visibility.Collapsed;
                Root.IsHitTestVisible = !_vm.Sending;
                break;
            case nameof(ComposeViewModel.DraftState): DraftText.Text = _vm.DraftState; break;
            case nameof(ComposeViewModel.Error): ErrorBar.Message = _vm.Error ?? ""; ErrorBar.IsOpen = !string.IsNullOrEmpty(_vm.Error); break;
            case nameof(ComposeViewModel.Notice): NoticeBar.Message = _vm.Notice ?? ""; NoticeBar.IsOpen = !string.IsNullOrEmpty(_vm.Notice); break;
        }
        SendButton.IsEnabled = _vm.CanSend;
    }

    // ---- editor ----

    private void OnSubjectChanged(object sender, TextChangedEventArgs e) { _vm.Subject = SubjectBox.Text; _vm.Touch(); }
    private void OnEditorChanged(object sender, RoutedEventArgs e) { Capture(); _vm.Touch(); }

    private void Capture()
    {
        var paras = Extract(Editor.Document);
        _snapshot = (ComposeHtml.ToHtml(paras), ComposeHtml.ToText(paras));
    }

    /// <summary>Walks the document by character format runs and paragraphs into plain model records.</summary>
    private static IReadOnlyList<ComposeParagraph> Extract(RichEditTextDocument doc)
    {
        doc.GetText(TextGetOptions.None, out var all);
        var paragraphs = new List<ComposeParagraph>();
        var runs = new List<ComposeRun>();
        var list = ListKind.None;
        var atStart = true;
        void Flush() { paragraphs.Add(new ComposeParagraph(runs.ToList(), list)); runs.Clear(); atStart = true; }
        var pos = 0;
        while (pos < all.Length)
        {
            if (atStart)
            {
                list = doc.GetRange(pos, pos).ParagraphFormat.ListType switch { MarkerType.Bullet => ListKind.Bullet, MarkerType.None or MarkerType.Undefined => ListKind.None, _ => ListKind.Numbered };
                atStart = false;
            }
            var r = doc.GetRange(pos, pos);
            r.Expand(TextRangeUnit.CharacterFormat);
            var end = Math.Clamp(r.EndPosition, pos + 1, all.Length);
            var seg = all[pos..end];
            var link = r.Link;
            if (link.Length >= 2) link = link.Trim('"');
            var cut = seg.IndexOf('\r');
            while (cut >= 0)
            {
                var head = seg[..cut];
                if (head.Length > 0) runs.Add(new ComposeRun(head, r.CharacterFormat.Bold == FormatEffect.On, r.CharacterFormat.Italic == FormatEffect.On, link.Length > 0 ? link : null));
                Flush();
                seg = seg[(cut + 1)..];
                if (atStart && seg.Length > 0) list = doc.GetRange(end - seg.Length, end - seg.Length).ParagraphFormat.ListType switch { MarkerType.Bullet => ListKind.Bullet, MarkerType.None or MarkerType.Undefined => ListKind.None, _ => ListKind.Numbered };
                atStart = false;
                cut = seg.IndexOf('\r');
            }
            if (seg.Length > 0) runs.Add(new ComposeRun(seg, r.CharacterFormat.Bold == FormatEffect.On, r.CharacterFormat.Italic == FormatEffect.On, link.Length > 0 ? link : null));
            pos = end;
        }
        if (runs.Count > 0) Flush();
        return paragraphs;
    }

    private void OnBold(object sender, RoutedEventArgs e) { var f = Editor.Document.Selection.CharacterFormat; f.Bold = f.Bold == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; Editor.Document.Selection.CharacterFormat = f; Editor.Focus(FocusState.Programmatic); }
    private void OnItalic(object sender, RoutedEventArgs e) { var f = Editor.Document.Selection.CharacterFormat; f.Italic = f.Italic == FormatEffect.On ? FormatEffect.Off : FormatEffect.On; Editor.Document.Selection.CharacterFormat = f; Editor.Focus(FocusState.Programmatic); }

    private void OnBullets(object sender, RoutedEventArgs e) => ToggleList(MarkerType.Bullet);
    private void OnNumbers(object sender, RoutedEventArgs e) => ToggleList(MarkerType.Arabic);
    private void ToggleList(MarkerType type)
    {
        var pf = Editor.Document.Selection.ParagraphFormat;
        pf.ListType = pf.ListType == type ? MarkerType.None : type;
        if (type == MarkerType.Arabic) pf.ListStyle = MarkerStyle.Period;
        Editor.Document.Selection.ParagraphFormat = pf;
        Editor.Focus(FocusState.Programmatic);
    }

    private async void OnLink(object sender, RoutedEventArgs e)
    {
        try { await OnLinkCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnLinkCore(object sender, RoutedEventArgs e)
    {
        var box = new TextBox { PlaceholderText = "https://", MinWidth = 320 };
        var dialog = new ContentDialog { XamlRoot = Root.XamlRoot, Title = "Insert link", Content = box, PrimaryButtonText = "Insert", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary, RequestedTheme = Root.ActualTheme };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var url = box.Text.Trim();
        if (!ComposeHtml.IsSafeLink(url)) { ErrorBar.Message = "Links must start with http, https or mailto."; ErrorBar.IsOpen = true; return; }
        var sel = Editor.Document.Selection;
        if (sel.StartPosition == sel.EndPosition) sel.Text = url;
        sel.Link = "\"" + url + "\"";
        Editor.Focus(FocusState.Programmatic);
    }

    // ---- recipients ----

    private void OnShowCc(object sender, RoutedEventArgs e) { CcRow.Visibility = Visibility.Visible; CcLink.Visibility = Visibility.Collapsed; (CcHost.Content as RecipientBox)?.FocusInput(); }
    private void OnShowBcc(object sender, RoutedEventArgs e) { BccRow.Visibility = Visibility.Visible; BccLink.Visibility = Visibility.Collapsed; (BccHost.Content as RecipientBox)?.FocusInput(); }

    // ---- attachments ----

    private async void OnAttach(object sender, RoutedEventArgs e)
    {
        try { await OnAttachCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnAttachCore(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker();
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var files = await picker.PickMultipleFilesAsync();
        if (files is null) return;
        foreach (var f in files) await AddFileAsync(f);
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems)) { e.AcceptedOperation = DataPackageOperation.Copy; e.DragUIOverride.Caption = "Attach"; }
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        try { await OnDropCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnDropCore(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        // the deferral keeps the drag data alive only while the items are read; uploads continue after it is released
        var deferral = e.GetDeferral();
        IReadOnlyList<IStorageItem> items;
        try { items = await e.DataView.GetStorageItemsAsync(); }
        finally { deferral.Complete(); }
        foreach (var item in items)
            if (item is StorageFile f) await AddFileAsync(f);
    }

    private async Task AddFileAsync(StorageFile file)
    {
        var props = await file.GetBasicPropertiesAsync();
        await using var stream = (await file.OpenReadAsync()).AsStreamForRead();
        await _vm.AddAttachmentAsync(file.Name, file.ContentType, (long)props.Size, stream);
    }

    private async void OnRemoveAttachment(object sender, RoutedEventArgs e)
    {
        try { await OnRemoveAttachmentCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnRemoveAttachmentCore(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is AttachmentVm a) await _vm.RemoveAttachmentAsync(a);
    }

    // ---- send and discard ----

    private async void OnSend(object sender, RoutedEventArgs e)
    {
        try { await OnSendCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnSendCore(object sender, RoutedEventArgs e)
    {
        Capture();
        if (await _vm.SendAsync())
        {
            _done = true;
            _onSent(_vm.Notice is { Length: > 0 } n ? "Message sent. " + n : "Message sent");
            Close();
        }
    }

    private async void OnDiscard(object sender, RoutedEventArgs e)
    {
        try { await OnDiscardCore(sender, e); }
        catch (Exception ex) { ErrorBar.Message = "Something went wrong. " + ex.Message; ErrorBar.IsOpen = true; }
    }

    private async Task OnDiscardCore(object sender, RoutedEventArgs e)
    {
        _done = true;
        await _vm.DiscardAsync();
        Close();
    }
}
