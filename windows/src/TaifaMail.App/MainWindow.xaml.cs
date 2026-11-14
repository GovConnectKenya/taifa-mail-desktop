using Microsoft.UI;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using TaifaMail.Core.ViewModels;
using Windows.Graphics;

namespace TaifaMail.App;

/// <summary>
/// The one window: Mica backdrop, content extended into the title bar. Pages expose their title row as the
/// drag region and their controls as pass-through regions so clicks reach the controls and empty space drags.
/// </summary>
public sealed partial class MainWindow : Window
{
    public static readonly SizeInt32 DefaultSize = new(1280, 800);
    public static readonly SizeInt32 MinimumSize = new(900, 600);

    private Page? _page;

    public MainWindow()
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        if (MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop();
            Root.Background = new SolidColorBrush(Colors.Transparent);
        }
        AppWindow.Resize(DefaultSize);
        AppWindow.Title = "Taifa Mail";
        var bar = AppWindow.TitleBar;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.PreferredHeightOption = TitleBarHeightOption.Tall;
        Root.ActualThemeChanged += (_, _) => ApplyCaptionColors();
        Root.SizeChanged += (_, _) => UpdateChrome();
        AppWindow.Changed += (_, e) =>
        {
            if (e.DidSizeChange && (AppWindow.Size.Width < MinimumSize.Width || AppWindow.Size.Height < MinimumSize.Height))
                AppWindow.Resize(new SizeInt32(Math.Max(AppWindow.Size.Width, MinimumSize.Width), Math.Max(AppWindow.Size.Height, MinimumSize.Height)));
        };
        ApplyCaptionColors();
    }

    public void ApplyTheme(string theme) =>
        Root.RequestedTheme = theme switch { "light" => ElementTheme.Light, "dark" => ElementTheme.Dark, _ => ElementTheme.Default };

    private void ApplyCaptionColors()
    {
        var dark = Root.ActualTheme == ElementTheme.Dark;
        var fg = dark ? Colors.White : Colors.Black;
        AppWindow.TitleBar.ButtonForegroundColor = fg;
        AppWindow.TitleBar.ButtonHoverForegroundColor = fg;
        AppWindow.TitleBar.ButtonHoverBackgroundColor = dark ? Windows.UI.Color.FromArgb(25, 255, 255, 255) : Windows.UI.Color.FromArgb(25, 0, 0, 0);
        AppWindow.TitleBar.ButtonInactiveForegroundColor = dark ? Windows.UI.Color.FromArgb(255, 157, 151, 143) : Windows.UI.Color.FromArgb(255, 106, 101, 94);
    }

    /// <summary>Swaps the page and wires the title bar for it.</summary>
    public void Show(Page page)
    {
        if (_page is not null) _page.LayoutUpdated -= OnPageLayout;
        _page = page;
        Host.Content = page;
        page.LayoutUpdated += OnPageLayout;
        page.Loaded += (_, _) => UpdateChrome();
        UpdateChrome();
    }

    private void OnPageLayout(object? sender, object e) => UpdateChrome();

    private void UpdateChrome()
    {
        if (_page is null || Content?.XamlRoot is null) return;
        var scale = Content.XamlRoot.RasterizationScale;
        if (_page is not Services.IChromePage page) return;
        try
        {
            SetTitleBar(page.TitleBarElement);
            page.SetCaptionInset(AppWindow.TitleBar.RightInset / scale);
            var rects = new List<RectInt32>();
            foreach (var el in page.InteractiveElements)
            {
                if (el.ActualWidth <= 0 || el.ActualHeight <= 0 || el.XamlRoot is null) continue;
                var b = el.TransformToVisual(null).TransformBounds(new Windows.Foundation.Rect(0, 0, el.ActualWidth, el.ActualHeight));
                rects.Add(new RectInt32((int)(b.X * scale), (int)(b.Y * scale), (int)(b.Width * scale), (int)(b.Height * scale)));
            }
            InputNonClientPointerSource.GetForWindowId(AppWindow.Id).SetRegionRects(NonClientRegionKind.Passthrough, rects.ToArray());
        }
        catch (Exception) { /* title bar wiring is cosmetic; never let it break a page */ }
    }
}
