using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.UI.ViewManagement;

namespace TaifaMail.App.Controls;

/// <summary>
/// A loading placeholder: the skeleton base fill with the sheen fill fading over it every 1.2 s.
/// The pulse stops when the user turned animations off in Windows.
/// </summary>
public sealed class SkeletonBar : UserControl
{
    private static readonly bool Animate = new UISettings().AnimationsEnabled;
    private readonly Border _sheen;
    private Storyboard? _board;

    public static readonly DependencyProperty RadiusProperty = DependencyProperty.Register(nameof(Radius), typeof(double), typeof(SkeletonBar), new PropertyMetadata(4.0, (d, _) => ((SkeletonBar)d).ApplyRadius()));
    public double Radius { get => (double)GetValue(RadiusProperty); set => SetValue(RadiusProperty, value); }

    public SkeletonBar()
    {
        IsTabStop = false;
        var grid = (Grid)XamlReader.Load(@"<Grid xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'>
  <Border x:Name='Base' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Background='{ThemeResource TmTrackBrush}'/>
  <Border x:Name='Sheen' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Background='{ThemeResource TmSkeletonSheenBrush}' Opacity='0'/>
</Grid>");
        _sheen = (Border)grid.FindName("Sheen");
        Content = grid;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        ApplyRadius();
        Loaded += (_, _) => Start();
        Unloaded += (_, _) => _board?.Stop();
    }

    private void ApplyRadius()
    {
        if (Content is Grid g) foreach (var c in g.Children.OfType<Border>()) c.CornerRadius = new CornerRadius(Radius);
    }

    private void Start()
    {
        if (!Animate) return;
        var anim = new DoubleAnimation { From = 0, To = 1, Duration = new Duration(TimeSpan.FromSeconds(0.6)), AutoReverse = true, EnableDependentAnimation = true };
        Storyboard.SetTarget(anim, _sheen);
        Storyboard.SetTargetProperty(anim, "Opacity");
        _board = new Storyboard { RepeatBehavior = RepeatBehavior.Forever };
        _board.Children.Add(anim);
        _board.Begin();
    }
}
