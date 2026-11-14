using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace TaifaMail.App.Controls;

/// <summary>Minimal wrapping row layout for recipient chips.</summary>
public sealed class WrapPanel : Panel
{
    protected override Size MeasureOverride(Size available)
    {
        double x = 0, y = 0, rowH = 0, maxW = 0;
        foreach (var c in Children)
        {
            c.Measure(new Size(available.Width, available.Height));
            var s = c.DesiredSize;
            if (x > 0 && x + s.Width > available.Width) { y += rowH; x = 0; rowH = 0; }
            x += s.Width;
            rowH = Math.Max(rowH, s.Height);
            maxW = Math.Max(maxW, x);
        }
        return new Size(double.IsInfinity(available.Width) ? maxW : available.Width, y + rowH);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double x = 0, y = 0, rowH = 0;
        foreach (var c in Children)
        {
            var s = c.DesiredSize;
            if (x > 0 && x + s.Width > final.Width) { y += rowH; x = 0; rowH = 0; }
            var w = c == Children[^1] ? Math.Max(s.Width, final.Width - x) : s.Width;
            c.Arrange(new Rect(x, y, w, s.Height));
            x += s.Width;
            rowH = Math.Max(rowH, s.Height);
        }
        return final;
    }
}
