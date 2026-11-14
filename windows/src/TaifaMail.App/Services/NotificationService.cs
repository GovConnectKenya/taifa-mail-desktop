using System.Drawing;
using System.Runtime.InteropServices;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using TaifaMail.Core.Notifications;

namespace TaifaMail.App.Services;

/// <summary>
/// Windows App SDK toasts for new Inbox mail and the taskbar unread badge (an overlay icon on the taskbar button,
/// which needs no package identity). Activating a toast opens that thread.
/// </summary>
public sealed class NotificationService
{
    private bool _registered;

    /// <summary>Raised on the UI thread with (folder, uid) when the user activates a toast.</summary>
    public event Action<string, long>? ThreadRequested;

    public void Register(Microsoft.UI.Dispatching.DispatcherQueue ui)
    {
        if (_registered) return;
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, args) =>
            {
                if (args.Arguments.TryGetValue("uid", out var uid) && long.TryParse(uid, out var u))
                {
                    args.Arguments.TryGetValue("folder", out var folder);
                    ui.TryEnqueue(() =>
                    {
                        App.MainWindow.Activate();
                        ThreadRequested?.Invoke(folder ?? "INBOX", u);
                    });
                }
            };
            AppNotificationManager.Default.Register();
            _registered = true;
        }
        catch (Exception) { /* toasts are optional: a registration failure leaves the app fully usable */ }
    }

    public void Show(ToastInfo t)
    {
        if (!_registered) return;
        try
        {
            var n = new AppNotificationBuilder()
                .AddText(t.Sender)
                .AddText(t.Subject)
                .AddArgument("folder", t.Folder)
                .AddArgument("uid", t.Uid.ToString())
                .BuildNotification();
            n.ExpiresOnReboot = true;
            AppNotificationManager.Default.Show(n);
        }
        catch (Exception) { }
    }

    public void ClearAll()
    {
        if (!_registered) return;
        try { _ = AppNotificationManager.Default.RemoveAllAsync(); } catch (Exception) { }
    }

    // ---- taskbar badge ----

    public void SetBadge(IntPtr hwnd, string label)
    {
        try
        {
            var list = (ITaskbarList3)new TaskbarList();
            list.HrInit();
            if (label.Length == 0) { list.SetOverlayIcon(hwnd, IntPtr.Zero, ""); return; }
            using var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                using var fill = new SolidBrush(Color.FromArgb(0x00, 0x86, 0x4E));
                g.FillEllipse(fill, 0, 0, 31, 31);
                using var font = new Font("Segoe UI", label.Length > 2 ? 12f : 16f, FontStyle.Bold, GraphicsUnit.Pixel);
                var size = g.MeasureString(label, font);
                g.DrawString(label, font, Brushes.White, (32 - size.Width) / 2f, (32 - size.Height) / 2f);
            }
            var icon = bmp.GetHicon();
            try { list.SetOverlayIcon(hwnd, icon, $"{label} unread"); }
            finally { DestroyIcon(icon); }
        }
        catch (Exception) { }
    }

    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr h);

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] private class TaskbarList { }

    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
        void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
        void SetProgressState(IntPtr hwnd, int flags);
        void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        void UnregisterTab(IntPtr hwndTab);
        void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint reserved);
        void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
    }
}
