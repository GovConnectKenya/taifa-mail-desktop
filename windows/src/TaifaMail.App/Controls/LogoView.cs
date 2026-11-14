using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace TaifaMail.App.Controls;

/// <summary>
/// The real Taifa Mail logo (webmail/static/logos): the green and black file on light surfaces and the white
/// variant on dark ones. Never recoloured or redrawn; only the file changes with the theme.
/// </summary>
public sealed class LogoView : UserControl
{
    private readonly Image _image = new() { Stretch = Stretch.Uniform };

    public static readonly DependencyProperty HeightPxProperty = DependencyProperty.Register(nameof(HeightPx), typeof(double), typeof(LogoView), new PropertyMetadata(24.0, (d, _) => ((LogoView)d).Apply()));

    public LogoView()
    {
        IsTabStop = false;
        Content = _image;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this, "Taifa Mail");
        Loaded += (_, _) => Apply();
        ActualThemeChanged += (_, _) => Apply();
    }

    public double HeightPx { get => (double)GetValue(HeightPxProperty); set => SetValue(HeightPxProperty, value); }

    private void Apply()
    {
        _image.Height = HeightPx;
        // The artwork's viewBox is 287 by 282.
        _image.Width = HeightPx * 287.0 / 282.0;
        var file = ActualTheme == ElementTheme.Dark ? "taifa_logo_white.svg" : "taifa_logo.svg";
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Logo", file);
        if (File.Exists(path)) _image.Source = new SvgImageSource(new Uri(path)) { RasterizePixelHeight = HeightPx * 3 };
    }
}
