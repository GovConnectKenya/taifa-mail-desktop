import Foundation
import Observation
import SwiftUI
import UserNotifications
import AppKit

/// Local preferences (UserDefaults). Not mailbox data, so they survive sign out.
@MainActor @Observable
final class AppPreferences {
    private let defaults: UserDefaults
    var theme: ThemePreference { didSet { defaults.set(theme.rawValue, forKey: "theme") } }
    var density: Density { didSet { defaults.set(density.rawValue, forKey: "density") } }
    var notificationsEnabled: Bool { didSet { defaults.set(notificationsEnabled, forKey: "notifications") } }
    var badgeEnabled: Bool { didSet { defaults.set(badgeEnabled, forKey: "badge") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        theme = ThemePreference(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
        density = Density(rawValue: defaults.string(forKey: "density") ?? "") ?? .comfortable
        notificationsEnabled = defaults.object(forKey: "notifications") as? Bool ?? true
        badgeEnabled = defaults.object(forKey: "badge") as? Bool ?? true
    }
}

/// New mail notifications and the Dock badge.
@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    private let prefs: AppPreferences
    var onOpen: ((String, Int) -> Void)?   // folder, uid
    private var authorized = false

    init(prefs: AppPreferences) {
        self.prefs = prefs
        super.init()
        guard Bundle.main.bundleIdentifier != nil, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    func requestAuthorizationIfNeeded() {
        guard Bundle.main.bundleIdentifier != nil, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] ok, _ in
            Task { @MainActor in self?.authorized = ok }
        }
    }

    func updateBadge(_ unseen: Int) {
        NSApp?.dockTile.badgeLabel = (prefs.badgeEnabled && unseen > 0) ? (unseen > 999 ? "999+" : String(unseen)) : nil
    }

    func clearBadge() { NSApp?.dockTile.badgeLabel = nil }

    func notify(_ fresh: [Envelope]) {
        guard prefs.notificationsEnabled, authorized, !fresh.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        for e in fresh.prefix(3) {
            let c = UNMutableNotificationContent()
            c.title = e.fromName.isEmpty ? e.fromAddr : e.fromName
            c.subtitle = e.subject
            c.body = e.snippet
            c.sound = .default
            c.threadIdentifier = "inbox"
            c.userInfo = ["folder": e.folder, "uid": e.uid]
            center.add(UNNotificationRequest(identifier: "mail-\(e.folder)-\(e.uid)", content: c, trigger: nil))
        }
        if fresh.count > 3 {
            let c = UNMutableNotificationContent()
            c.title = "\(fresh.count - 3) more new messages"
            center.add(UNNotificationRequest(identifier: "mail-more-\(UUID().uuidString)", content: c, trigger: nil))
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let folder = info["folder"] as? String, let uid = info["uid"] as? Int else { return }
        await MainActor.run { self.onOpen?(folder, uid) }
    }
}


/// When to notify: only Inbox mail that is unread, not sent by the owner, not already known to the app.
enum NotificationPolicy {
    struct Decision: Equatable { var notify: [Envelope]; var knownAfter: Set<String> }

    /// `known` is nil on the first load of a session: everything is recorded, nothing notifies.
    static func decide(incoming: [ConversationSummary], known: Set<String>?, ownAddress: String) -> Decision {
        let ids = Set(incoming.map(\.latest.id))
        guard let known else { return Decision(notify: [], knownAfter: ids) }
        let own = ownAddress.lowercased()
        let fresh = incoming.filter(\.unread)
            .map(\.latest)
            .filter { !known.contains($0.id) && !$0.seen && $0.fromAddr.lowercased() != own }
        return Decision(notify: fresh, knownAfter: known.union(ids))
    }
}
