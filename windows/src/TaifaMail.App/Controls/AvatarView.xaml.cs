
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using TaifaMail.App.Services;
using TaifaMail.Core.Avatars;
using Windows.UI;

namespace TaifaMail.App.Controls;

/// <summary>
/// One avatar, drawn from <see cref="AvatarDecision"/> (spec section 7): a photo is a circle with cover fit, an
/// institution logo is a contained rounded tile on panel2, and no picture is a circle with the initial in white.
/// The placeholder shows until a picture resolves, so nothing flashes.
/// </summary>
public sealed partial class AvatarView : UserControl
{
    private int _version;

    public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(nameof(Size), typeof(double), typeof(AvatarView), new PropertyMetadata(36.0, (d, _) => ((AvatarView)d).Layout()));
    public static readonly DependencyProperty DecisionProperty = DependencyProperty.Register(nameof(Decision), typeof(AvatarDecision), typeof(AvatarView), new PropertyMetadata(null, (d, _) => ((AvatarView)d).Apply()));
    public static readonly DependencyProperty InitialsProperty = DependencyProperty.Register(nameof(Initials), typeof(string), typeof(AvatarView), new PropertyMetadata("", (d, _) => ((AvatarView)d).Layout()));
    public static readonly DependencyProperty FillColorProperty = DependencyProperty.Register(nameof(FillColor), typeof(string), typeof(AvatarView), new PropertyMetadata("#006900", (d, _) => ((AvatarView)d).Layout()));

    public AvatarView()
    {
        InitializeComponent();
        Layout();
    }

    public double Size { get => (double)GetValue(SizeProperty); set => SetValue(SizeProperty, value); }
    public AvatarDecision? Decision { get => (AvatarDecision?)GetValue(DecisionProperty); set => SetValue(DecisionProperty, value); }
    public string Initials { get => (string)GetValue(InitialsProperty); set => SetValue(InitialsProperty, value); }
    public string FillColor { get => (string)GetValue(FillColorProperty); set => SetValue(FillColorProperty, value); }

    private static Color Parse(string hex)
    {
        var h = hex.TrimStart('#');
        return Color.FromArgb(255, Convert.ToByte(h[..2], 16), Convert.ToByte(h[2..4], 16), Convert.ToByte(h[4..6], 16));
    }

    private void Layout()
    {
        var s = Size;
        Width = s; Height = s;
        _placeholder.Width = s; _placeholder.Height = s;
        _placeholder.CornerRadius = new CornerRadius(s / 2);
        try { _placeholder.Background = new SolidColorBrush(Parse(FillColor)); } catch (FormatException) { }
        _initial.Text = Initials;
        _initial.FontSize = Math.Max(11, Math.Round(s * 0.4));
        _photo.Width = s; _photo.Height = s; _photo.CornerRadius = new CornerRadius(s / 2);
        var tile = Math.Max(6, s * 0.25);
        _logo.Width = s; _logo.Height = s; _logo.CornerRadius = new CornerRadius(tile);
        _logo.Padding = new Thickness(Math.Round(s * 0.12));
    }

    private async void Apply()
    {
        var version = ++_version;
        var d = Decision;
        _photo.Visibility = Visibility.Collapsed;
        _logo.Visibility = Visibility.Collapsed;
        _placeholder.Visibility = Visibility.Visible;
        _initial.Visibility = Visibility.Visible;
        if (d is null || d.Kind == AvatarKind.None || d.Url is null || ImageCache.Instance is null) return;
        BitmapImage? image;
        try { image = await ImageCache.Instance.GetAsync(d.Url, (int)Size); }
        catch (Exception) { return; }
        if (image is null || version != _version) return;
        if (d.Kind == AvatarKind.Photo)
        {
            _photo.Background = new ImageBrush { ImageSource = image, Stretch = Stretch.UniformToFill };
            _photo.Visibility = Visibility.Visible;
        }
        else
        {
            _logoImage.Source = image;
            _logo.Visibility = Visibility.Visible;
        }
        _placeholder.Visibility = Visibility.Collapsed;
        _initial.Visibility = Visibility.Collapsed;
    }
}
