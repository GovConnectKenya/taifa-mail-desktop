using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using TaifaMail.Core.Net;

namespace TaifaMail.Core.Realtime;

public enum RealtimeKind { Connected, Pong, NewMail, FlagsChanged, MessageMoved, MessageDeleted, DraftSaved, FolderRead, Other }

public sealed record RealtimeEvent(RealtimeKind Kind, string Type, string? Folder, long? Uid, JsonElement Raw, string? MailboxId = null)
{
    /// <summary>Events that name a different mailbox than the active one are ignored (API contract section 8).</summary>
    public bool IsFor(string activeMailboxId) => MailboxId is null || string.Equals(MailboxId, activeMailboxId, StringComparison.OrdinalIgnoreCase);
}

public static class RealtimeParser
{
    public static RealtimeEvent? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement.Clone();
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return null;
            var type = t.GetString()!;
            string? folder = root.TryGetProperty("folder", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : null;
            long? uid = root.TryGetProperty("uid", out var u) && u.ValueKind == JsonValueKind.Number && u.TryGetInt64(out var n) ? n : null;
            var kind = type switch
            {
                "connected" => RealtimeKind.Connected,
                "pong" => RealtimeKind.Pong,
                "mailbox_message_new" or "new_mail" => RealtimeKind.NewMail,
                "mailbox_flags_changed" => RealtimeKind.FlagsChanged,
                "mailbox_message_moved" => RealtimeKind.MessageMoved,
                "mailbox_message_deleted" or "mailbox_message_purged" => RealtimeKind.MessageDeleted,
                "mailbox_draft_saved" => RealtimeKind.DraftSaved,
                "mailbox_folder_read" => RealtimeKind.FolderRead,
                _ => RealtimeKind.Other,
            };
            var mailbox = root.TryGetProperty("mailbox_id", out var mb) && mb.ValueKind == JsonValueKind.String ? mb.GetString() : null;
            return new RealtimeEvent(kind, type, folder, uid, root, mailbox);
        }
        catch (JsonException) { return null; }
    }
}

public static class Backoff
{
    /// <summary>Reconnect delay for attempt n (0 based): 1s doubling to a 30s cap, with up to 20 percent jitter.</summary>
    public static TimeSpan Delay(int attempt, Random? rng = null)
    {
        var baseMs = Math.Min(30_000, 1_000 * Math.Pow(2, Math.Min(attempt, 10)));
        var jitter = (rng ?? Random.Shared).NextDouble() * 0.2 * baseMs;
        return TimeSpan.FromMilliseconds(baseMs + jitter);
    }
}

/// <summary>
/// Listens on /ws/mailbox with the session cookies. Realtime is an optimisation:
/// callers also reconcile over REST on reconnect, so a missed event is never lost mail.
/// </summary>
public sealed class RealtimeClient : IAsyncDisposable
{
    private readonly TaifaApiClient _api;
    private static readonly TimeSpan PongTimeout = TimeSpan.FromSeconds(10);
    private long _lastFrameTick;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    public event Action<RealtimeEvent>? EventReceived;
    public event Action<bool>? ConnectionChanged;
    /// <summary>Raised on close code 4001 (session invalid) so the app can refresh or sign out.</summary>
    public event Action? AuthFailed;
    /// <summary>Raised on close code 4003 (onboarding or workforce policy): not retried.</summary>
    public event Action? PolicyClosed;
    /// <summary>Raised after every successful (re)connect so the app can reconcile over REST.</summary>
    public event Action? Reconnected;

    public RealtimeClient(TaifaApiClient api) => _api = api;

    public void Start()
    {
        if (_loop is { IsCompleted: false }) return;
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token));
    }

    public async Task StopAsync()
    {
        var cts = _cts;
        if (cts is null) return;
        cts.Cancel();
        try { if (_loop is not null) await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { }
        cts.Dispose();
        _cts = null;
        _loop = null;
    }

    public ValueTask DisposeAsync() => new(StopAsync());

    public static Uri SocketUri(Uri baseUri)
    {
        var b = new UriBuilder(baseUri) { Scheme = baseUri.Scheme == "https" ? "wss" : "ws", Path = "/ws/mailbox", Query = "token=__cookie__" };
        return b.Uri;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        var first = true;
        while (!ct.IsCancellationRequested)
        {
            using var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("Cookie", _api.CookieHeader());
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            try
            {
                await ws.ConnectAsync(SocketUri(_api.BaseUri), ct).ConfigureAwait(false);
                attempt = 0;
                ConnectionChanged?.Invoke(true);
                if (!first) Reconnected?.Invoke();
                first = false;
                await ReceiveAsync(ws, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (WebSocketException) { }
            catch (IOException) { }

            ConnectionChanged?.Invoke(false);
            if (ws.CloseStatus == (WebSocketCloseStatus)4003) { PolicyClosed?.Invoke(); break; }
            if (ws.CloseStatus == (WebSocketCloseStatus)4001) { AuthFailed?.Invoke(); }
            try { await Task.Delay(Backoff.Delay(attempt++), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ReceiveAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var ping = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ = Task.Run(async () =>
        {
            try
            {
                while (!ping.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    await Task.Delay(TimeSpan.FromSeconds(30), ping.Token).ConfigureAwait(false);
                    var sentAt = Environment.TickCount64;
                    await ws.SendAsync(Encoding.UTF8.GetBytes("ping"), WebSocketMessageType.Text, true, ping.Token).ConfigureAwait(false);
                    await Task.Delay(PongTimeout, ping.Token).ConfigureAwait(false);
                    if (Interlocked.Read(ref _lastFrameTick) < sentAt) { ws.Abort(); return; }
                }
            }
            catch (Exception) { }
        }, ping.Token);

        var sb = new StringBuilder();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            sb.Clear();
            WebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                if (r.MessageType == WebSocketMessageType.Close) { ping.Cancel(); return; }
                Interlocked.Exchange(ref _lastFrameTick, Environment.TickCount64);
                sb.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
            } while (!r.EndOfMessage);
            if (RealtimeParser.Parse(sb.ToString()) is { } ev) EventReceived?.Invoke(ev);
        }
        ping.Cancel();
    }
}
