import Foundation
import Network

enum RealtimeEvent: Equatable, Sendable {
    case newMail
    case flagsChanged(uid: Int, folder: String, seen: Bool?, flagged: Bool?)
    case moved(uid: Int, from: String, to: String)
    case deleted(uid: Int, folder: String)
    case reconcile        // events that only say "something changed"
    case ignored

    /// Parses one websocket text frame (API_CONTRACT section 8). `activeMailbox` scopes events.
    static func parse(_ text: String, activeMailbox: String) -> RealtimeEvent {
        guard let data = text.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = o["type"] as? String else { return .ignored }
        if let mb = o["mailbox_id"] as? String, mb.lowercased() != activeMailbox.lowercased() { return .ignored }
        let uid = o["uid"] as? Int
        let folder = o["folder"] as? String
        switch type {
        case "mailbox_message_new": return .newMail
        case "mailbox_flags_changed":
            if o["thread"] as? Bool == true { return .reconcile }
            guard let uid, let folder else { return .reconcile }
            return .flagsChanged(uid: uid, folder: folder, seen: o["seen"] as? Bool, flagged: o["flagged"] as? Bool)
        case "mailbox_message_moved":
            guard let uid, let from = o["from_folder"] as? String, let to = o["to_folder"] as? String else { return .reconcile }
            return .moved(uid: uid, from: from, to: to)
        case "mailbox_message_deleted", "mailbox_message_purged":
            guard let uid, let folder else { return .reconcile }
            return .deleted(uid: uid, folder: folder)
        case "mailbox_message_sent", "mailbox_folder_emptied", "mailbox_folder_read", "mailbox_draft_saved", "mailbox_important_changed":
            return .reconcile
        default: return .ignored
        }
    }
}

/// Websocket client for /ws/mailbox: ping every 30 s, pong within 10 s, exponential backoff,
/// close code 4001 asks the owner to refresh the session. Realtime is only a hint; the owner polls REST too.
final class RealtimeClient: @unchecked Sendable {
    private let api: APIClient
    private let mailboxId: @Sendable () -> String
    var onEvent: (@Sendable (RealtimeEvent) -> Void)?
    var onConnection: (@Sendable (Bool) -> Void)?
    var onAuthFailure: (@Sendable () async -> Bool)?

    private var task: URLSessionWebSocketTask?
    private var runner: Task<Void, Never>?

    init(api: APIClient, mailboxId: @escaping @Sendable () -> String) { self.api = api; self.mailboxId = mailboxId }

    static func backoff(attempt: Int) -> TimeInterval { min(60, pow(2, Double(min(attempt, 6)))) }

    func start() {
        stop()
        runner = Task { [weak self] in await self?.loop() }
    }

    func stop() {
        runner?.cancel(); runner = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        onConnection?(false)
    }

    private func loop() async {
        var attempt = 0
        while !Task.isCancelled {
            let socket = api.webSocket(path: "/ws/mailbox")
            task = socket
            socket.resume()
            let closeCode = await run(socket) { attempt = 0 }
            onConnection?(false)
            if Task.isCancelled { return }
            if closeCode == 4001 {
                // Session problem: try a refresh through the API client; stop if it is over.
                if await onAuthFailure?() != true { return }
            }
            try? await Task.sleep(nanoseconds: UInt64(Self.backoff(attempt: attempt) * 1_000_000_000))
            attempt += 1
        }
    }

    /// Returns the close code (0 when unknown).
    private func run(_ socket: URLSessionWebSocketTask, onOpen: @escaping () -> Void) async -> Int {
        let pinger = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { return }
                try? await socket.send(.string("ping"))
                _ = self
            }
        }
        defer { pinger.cancel(); socket.cancel(with: .goingAway, reason: nil) }
        while !Task.isCancelled {
            do {
                let msg = try await socket.receive()
                guard case let .string(text) = msg else { continue }
                if text.contains("\"connected\"") { onConnection?(true); onOpen(); onEvent?(.reconcile); continue }
                if text.contains("\"pong\"") { continue }
                let event = RealtimeEvent.parse(text, activeMailbox: mailboxId())
                if event != .ignored { onEvent?(event) }
            } catch {
                return Int(socket.closeCode.rawValue)
            }
        }
        return 0
    }
}

/// Network reachability (a hint; real failures still set the offline flag).
final class ConnectivityMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    var onChange: (@Sendable (Bool) -> Void)?
    func start() {
        monitor.pathUpdateHandler = { [weak self] path in self?.onChange?(path.status == .satisfied) }
        monitor.start(queue: DispatchQueue(label: "ke.govconnect.TaifaMail.path"))
    }
    func stop() { monitor.cancel() }
}
