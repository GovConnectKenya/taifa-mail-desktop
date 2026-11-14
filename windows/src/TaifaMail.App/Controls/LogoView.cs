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
    private readonly TextBlock _fallback = new() { Text = "Taifa Mail", Visibility = Visibility.Collapsed, VerticalAlignment = VerticalAlignment.Center, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };
    private readonly Grid _host = new();

    public static readonly DependencyProperty HeightPxProperty = DependencyProperty.Register(nameof(HeightPx), typeof(double), typeof(LogoView), new PropertyMetadata(24.0, (d, _) => ((LogoView)d).Apply()));

    public LogoView()
    {
        IsTabStop = false;
        _host.Children.Add(_image);
        _host.Children.Add(_fallback);
        Content = _host;
        _image.ImageFailed += (_, _) => _fallback.Visibility = Visibility.Visible;
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
        _fallback.Visibility = Visibility.Collapsed;
        var svg = new SvgImageSource(new Uri("ms-appx:///Assets/Logo/" + file)) { RasterizePixelHeight = HeightPx * 3 };
        svg.OpenFailed += (_, _) => _fallback.Visibility = Visibility.Visible;
        _image.Source = svg;
    }
}
