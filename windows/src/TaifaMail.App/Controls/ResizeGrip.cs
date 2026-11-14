using Microsoft.UI.Input;
using Microsoft.UI.Xaml.Controls;

namespace TaifaMail.App.Controls;

/// <summary>The splitter between list and reader: shows the horizontal resize cursor.</summary>
public sealed class ResizeGrip : Grid
{
    public ResizeGrip() => ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.SizeWestEast);
}
