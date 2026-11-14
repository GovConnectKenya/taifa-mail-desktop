#if PREVIEW_DATA
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using TaifaMail.App.Services;
using TaifaMail.App.Views;
using TaifaMail.Core.ViewModels;
using Windows.Graphics;

namespace TaifaMail.App.Preview;

/// <summary>
/// Debug only. `--preview-data` opens the app on fixture data without an account. With
/// `--screenshots DIR` it walks every screen and state, saves a PNG of each, and exits with 0 when all were taken.
/// </summary>
public static class PreviewBoot
{
    public static bool Requested(string[] args) => args.Contains("--preview-data", StringComparer.OrdinalIgnoreCase);

    private static string? ArgValue(string[] args, string name)
    {
        var i = Array.FindIndex(args, a => a.Equals(name, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static ShellContext Context(PreviewMail mail) => new()
    {
        Mail = mail,
        Auth = new PreviewAuth(),
        Me = PreviewData.Me,
        ApiBase = "https://mail.example.test",
        IsPreview = true,
    };

    public static async Task RunAsync(MainWindow window, string[] args)
    {
        var shots = ArgValue(args, "--screenshots");
        if (shots is null)
        {
            window.Show(new ShellPage(Context(new PreviewMail())));
            return;
        }
        var code = 1;
        try
        {
            Directory.CreateDirectory(shots);
            await Walk(window, shots);
            code = 0;
        }
        catch (Exception e)
        {
            File.WriteAllText(Path.Combine(shots, "FAILED.txt"), e.ToString());
        }
        window.Close();
        Environment.Exit(code);
    }

    private static async Task Walk(MainWindow window, string dir)
    {
        window.AppWindow.MoveAndResize(new RectInt32(0, 0, 1000, 700));
        SetForegroundWindow(WinRT.Interop.WindowNative.GetWindowHandle(window));
        await Task.Delay(1000);

        foreach (var theme in new[] { "light", "dark" })
        {
            window.ApplyTheme(theme);

            // Sign in screens
            var vm = new SignInViewModel(new PreviewAuth());
            window.Show(new SignInPage(vm, sessionEnded: false));
            await Task.Delay(900);
            Capture(window, Path.Combine(dir, $"{theme}-01-sign-in.png"));

            vm.Address = "demo.officer@example.go.ke";
            vm.Password = "x";
            await vm.SubmitPasswordAsync();
            await Task.Delay(700);
            Capture(window, Path.Combine(dir, $"{theme}-02-second-factor.png"));

            var ended = new SignInViewModel(new PreviewAuth()) { Address = "demo.officer@example.go.ke" };
            window.Show(new SignInPage(ended, sessionEnded: true));
            await Task.Delay(700);
            Capture(window, Path.Combine(dir, $"{theme}-03-sign-in-session-ended.png"));

            // Loading skeleton: a slow API
            var slow = new PreviewMail { Delay = TimeSpan.FromSeconds(30) };
            window.Show(new ShellPage(Context(slow)));
            await Task.Delay(1500);
            Capture(window, Path.Combine(dir, $"{theme}-04-loading.png"));

            // Inbox with the reader open on an HTML message (remote images blocked)
            var mail = new PreviewMail();
            var shell = new ShellPage(Context(mail));
            window.Show(shell);
            await Task.Delay(2500);
            Capture(window, Path.Combine(dir, $"{theme}-05-inbox-no-selection.png"));
            await shell.SelectThreadAsync(0);
            await Task.Delay(3500);
            Capture(window, Path.Combine(dir, $"{theme}-06-reader-html.png"));
            await shell.SelectThreadAsync(2);
            await Task.Delay(2000);
            Capture(window, Path.Combine(dir, $"{theme}-07-reader-auth-warning.png"));

            // Empty folder, error and offline
            shell.Nav_SelectByPath("Archive");
            await Task.Delay(1500);
            Capture(window, Path.Combine(dir, $"{theme}-08-empty-folder.png"));

            var failing = new PreviewMail { Fail = true };
            window.Show(new ShellPage(Context(failing)));
            await Task.Delay(2000);
            Capture(window, Path.Combine(dir, $"{theme}-09-error.png"));

            var offline = new PreviewMail { Offline = true };
            window.Show(new ShellPage(Context(offline)));
            await Task.Delay(2000);
            Capture(window, Path.Combine(dir, $"{theme}-10-offline.png"));
        }
    }

    private static void Capture(MainWindow window, string path)
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        DwmGetWindowAttribute(hwnd, 9, out RECT r, Marshal.SizeOf<RECT>());
        var w = r.Right - r.Left;
        var h = r.Bottom - r.Top;
        using var bmp = new Bitmap(w, h);
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h));
        bmp.Save(path, ImageFormat.Png);
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
}
#endif
