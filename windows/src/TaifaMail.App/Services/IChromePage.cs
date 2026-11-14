using Microsoft.UI.Xaml;

namespace TaifaMail.App.Services;

/// <summary>A page that owns its title bar row: drag region, pass through controls and the caption button inset.</summary>
public interface IChromePage
{
    FrameworkElement TitleBarElement { get; }
    IEnumerable<FrameworkElement> InteractiveElements { get; }
    void SetCaptionInset(double inset);
}
