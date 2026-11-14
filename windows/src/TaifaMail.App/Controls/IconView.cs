using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Shape = Microsoft.UI.Xaml.Shapes.Shape;
using ShapePath = Microsoft.UI.Xaml.Shapes.Path;

namespace TaifaMail.App.Controls;

/// <summary>
/// Draws one vendored Iconsax glyph (rounded, linear, 24 grid, 1.5 stroke) in the current Foreground.
/// The stroke data lives in Styles/IconData.xaml; Assets/Icons holds the same glyphs as SVG files.
/// </summary>
public sealed class IconView : UserControl
{
    private readonly ShapePath _path = new() { StrokeThickness = 1.5, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, Stretch = Stretch.None };
    private readonly Viewbox _box = new() { Stretch = Stretch.Uniform };
    private readonly Canvas _canvas = new() { Width = 24, Height = 24 };

    public static readonly DependencyProperty NameProperty = DependencyProperty.Register(nameof(IconName), typeof(string), typeof(IconView), new PropertyMetadata("", (d, _) => ((IconView)d).Refresh()));
    public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(nameof(Size), typeof(double), typeof(IconView), new PropertyMetadata(16.0, (d, e) => ((IconView)d).Resize((double)e.NewValue)));
    public static readonly DependencyProperty MirrorProperty = DependencyProperty.Register(nameof(Mirror), typeof(bool), typeof(IconView), new PropertyMetadata(false, (d, _) => ((IconView)d).Refresh()));

    public IconView()
    {
        IsTabStop = false;
        _canvas.Children.Add(_path);
        _box.Child = _canvas;
        Content = _box;
        Resize(16);
        _path.SetBinding(Shape.StrokeProperty, new Microsoft.UI.Xaml.Data.Binding { Source = this, Path = new PropertyPath(nameof(Foreground)) });
        Loaded += (_, _) => Refresh();
    }

    public string IconName { get => (string)GetValue(NameProperty); set => SetValue(NameProperty, value); }
    public double Size { get => (double)GetValue(SizeProperty); set => SetValue(SizeProperty, value); }
    public bool Mirror { get => (bool)GetValue(MirrorProperty); set => SetValue(MirrorProperty, value); }

    private void Resize(double s) { Width = s; Height = s; _box.Width = s; _box.Height = s; }

    private void Refresh()
    {
        if (string.IsNullOrEmpty(IconName)) { _path.Data = null; return; }
        if (IconData.Paths.TryGetValue(IconName, out var d))
            _path.Data = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), d);
        _canvas.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
        _canvas.RenderTransform = Mirror ? new ScaleTransform { ScaleX = -1 } : null;
    }
}
