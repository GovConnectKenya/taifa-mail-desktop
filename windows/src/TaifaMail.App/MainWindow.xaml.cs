using Microsoft.UI;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
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
    // Sizes are in effective pixels (DIP); they are scaled by the monitor DPI when applied.
    public const int DefaultWidthDip = 1280, DefaultHeightDip = 800, MinWidthDip = 900, MinHeightDip = 600;
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);

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
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        if (scale <= 0) scale = 1;
        AppWindow.Resize(new SizeInt32((int)(DefaultWidthDip * scale), (int)(DefaultHeightDip * scale)));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = (int)(MinWidthDip * scale);
            presenter.PreferredMinimumHeight = (int)(MinHeightDip * scale);
        }
        AppWindow.Title = "Taifa Mail";
        var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "taifa.ico");
        if (File.Exists(ico)) AppWindow.SetIcon(ico);
        var bar = AppWindow.TitleBar;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.PreferredHeightOption = TitleBarHeightOption.Tall;
        Root.ActualThemeChanged += (_, _) => ApplyCaptionColors();
        Root.SizeChanged += (_, _) => UpdateChrome();
        ApplyCaptionColors();
    }

    public void ApplyTheme(string theme) =>
        Root.RequestedTheme = theme switch { "light" => ElementTheme.Light, "dark" => ElementTheme.Dark, _ => ElementTheme.Default };

    private void ApplyCaptionColors()
    {
        var dark = Root.ActualTheme == ElementTheme.Dark;
        // Colours come from the design tokens: surface2 for hover, border1 for pressed, mutedSoft for inactive.
        AppWindow.TitleBar.ButtonForegroundColor = dark ? Windows.UI.Color.FromArgb(255, 0xEC, 0xEC, 0xEC) : Windows.UI.Color.FromArgb(255, 0, 0, 0);
        AppWindow.TitleBar.ButtonHoverForegroundColor = AppWindow.TitleBar.ButtonForegroundColor;
        AppWindow.TitleBar.ButtonPressedForegroundColor = AppWindow.TitleBar.ButtonForegroundColor;
        AppWindow.TitleBar.ButtonHoverBackgroundColor = dark ? Windows.UI.Color.FromArgb(255, 0x24, 0x24, 0x24) : Windows.UI.Color.FromArgb(255, 0xED, 0xF3, 0xEF);
        AppWindow.TitleBar.ButtonPressedBackgroundColor = dark ? Windows.UI.Color.FromArgb(255, 0x2E, 0x2E, 0x2E) : Windows.UI.Color.FromArgb(255, 0xDC, 0xE5, 0xDF);
        AppWindow.TitleBar.ButtonInactiveForegroundColor = dark ? Windows.UI.Color.FromArgb(255, 0x94, 0x94, 0x94) : Windows.UI.Color.FromArgb(255, 0x5C, 0x6F, 0x67);
    }

    /// <summary>Swaps the page and wires the title bar for it.</summary>
    public void Show(Page page)
    {
        _page = page;
        Host.Content = page;
        page.Loaded += (_, _) => RefreshChrome();
        page.SizeChanged += (_, _) => RefreshChrome();
        UpdateChrome();
    }

    /// <summary>Recomputes drag and pass through regions. Called on load, resize and pane or column changes only.</summary>
    public void RefreshChrome() => UpdateChrome();

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
            var source = InputNonClientPointerSource.GetForWindowId(AppWindow.Id);
            source.SetRegionRects(NonClientRegionKind.Passthrough, rects.ToArray());
            var caption = new List<RectInt32>();
            foreach (var el in page.CaptionElements)
            {
                if (el.ActualWidth <= 0 || el.XamlRoot is null) continue;
                var b = el.TransformToVisual(null).TransformBounds(new Windows.Foundation.Rect(0, 0, el.ActualWidth, el.ActualHeight));
                caption.Add(new RectInt32((int)(b.X * scale), (int)(b.Y * scale), (int)(b.Width * scale), (int)(b.Height * scale)));
            }
            source.SetRegionRects(NonClientRegionKind.Caption, caption.ToArray());
        }
        catch (Exception) { /* title bar wiring is cosmetic; never let it break a page */ }
    }
}
