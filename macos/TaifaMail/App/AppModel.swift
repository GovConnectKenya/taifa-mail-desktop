import Foundation
import Observation
import SwiftUI
import AppKit

enum AuthMessages {
    static let onboarding = "Finish setting up this mailbox on the web before signing in here."
    static let mfaEnrolment = "Set up two factor sign in on the web first."
}

/// What to do with a failed launch check. Only a session the client itself declared over (the refresh was
/// refused with 401 or 403) ends it; offline, timeouts, 5xx, a bare 401 or a response the app cannot read all
/// open the cached mailbox and retry.
enum LaunchDecision: Equatable {
    case endSession, openOffline
    static func classify(_ error: Error) -> LaunchDecision { (error as? APIError) == .sessionEnded ? .endSession : .openOffline }
}

enum SignInStep: Equatable { case password, codeAddress, codeEntry, secondFactor }

@MainActor @Observable
final class SignInModel {
    var step: SignInStep = .password
    var address = ""
    var password = ""
    var code = ""
    var busy = false
    var error: String?
    var info: String?

    func reset() { step = .password; password = ""; code = ""; busy = false; error = nil; info = nil }
}

@MainActor @Observable
final class AppModel {
    enum Phase: Equatable { case launching, signedOut, signedIn, setupRequired }

    var phase: Phase = .launching
    var session: MailboxSession?
    var switchable: [SwitchableMailbox] = []
    var store: MailStore?
    private(set) var realtimeConnected = false
    var sessionBanner: String?
    private(set) var networkOnline = true
    private(set) var setupDetail = ""
    @ObservationIgnored private var launched = false
    private(set) var launchCount = 0
    private(set) var storageNotice: String?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    let signIn = SignInModel()
    let prefs: AppPreferences
    let notifications: NotificationManager

    @ObservationIgnored let api: APIClient
    @ObservationIgnored let auth: AuthService
    @ObservationIgnored let cache: OfflineCache
    @ObservationIgnored let secrets: SecretStore
    @ObservationIgnored let cookies: CookiePersistence
    @ObservationIgnored private var realtime: RealtimeClient?
    @ObservationIgnored private let mailboxBox = SendableBox("")
    @ObservationIgnored private let connectivity = ConnectivityMonitor()
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    let isPreview: Bool
    @ObservationIgnored var openMainWindow: (() -> Void)?

    init(secrets: SecretStore = KeychainSecretStore(), cacheDirectory: URL = OfflineCache.defaultDirectory(),
         baseURL: URL = APIClient.productionBase, defaults: UserDefaults = .standard, preview: Bool = false) {
        self.isPreview = preview
        self.secrets = secrets
        self.api = APIClient(baseURL: baseURL)
        self.auth = AuthService(api: api)
        let loaded = CacheKey.load(secrets)
        // A new key makes old files unreadable: delete them. A transient Keychain error must not touch them at all,
        // so this run caches in a throwaway folder.
        if loaded.created { try? FileManager.default.removeItem(at: cacheDirectory) }
        let dir = (loaded.persisted || loaded.created) ? cacheDirectory : FileManager.default.temporaryDirectory.appendingPathComponent("TaifaMailCache-\(UUID().uuidString)")
        self.cache = OfflineCache(directory: dir, key: loaded.key)
        self.cookies = CookiePersistence(store: secrets, storage: api.cookieStorage)
        self.prefs = AppPreferences(defaults: defaults)
        self.notifications = NotificationManager(prefs: prefs)
        ImageLoader.shared.baseURL = baseURL
        api.onCookiesChanged = { [cookies] in cookies.scheduleSave() }
        cookies.onError = { [weak self] msg in Task { @MainActor in self?.storageNotice = msg } }
        api.onSessionEnded = { [weak self] in Task { @MainActor in self?.sessionEnded() } }
        connectivity.onChange = { [weak self] online in Task { @MainActor in self?.networkOnline = online; self?.store?.setOffline(!online) } }
    }

    // MARK: Launch

    /// Runs the launch sequence once, however many windows ask for it.
    func launchIfNeeded() async {
        guard !launched else { return }
        launched = true
        launchCount += 1
        await launch()
    }

    private func launch() async {
        #if DEBUG
        if isPreview { startPreview(); return }
        #endif
        AttachmentFiles.purge()
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in AttachmentFiles.purge() }
        cookies.restore()
        connectivity.start()
        notifications.onOpen = { [weak self] folder, uid in self?.openFromNotification(folder: folder, uid: uid) }
        notifications.inboxOnScreen = { [weak self] in
            guard let st = self?.store else { return false }
            return st.currentFolder?.role == .inbox && !st.isSearching
        }
        guard cookies.hasSession else { phase = .signedOut; return }
        do {
            let me = try await auth.me()
            finishSignIn(me)
        } catch {
            // Only a definite 401 or 403 (after the refresh already failed) ends the session. Anything else
            // (offline, 5xx, a response the app cannot read) opens the cached mailbox and retries.
            if LaunchDecision.classify(error) == .endSession {
                await wipeLocalState()
                phase = .signedOut
            } else if let data = secrets.read("identity"), let s = try? JSONDecoder().decode(MailboxSession.self, from: data) {
                finishSignIn(s, offline: true)
                scheduleSessionRetry()
            } else {
                sessionBanner = "Could not reach Taifa Mail. Check your connection and try again."
                phase = .signedOut
            }
        }
    }

    /// After an offline or failed launch, keep trying to confirm the session.
    private func scheduleSessionRetry() {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, self.phase == .signedIn else { return }
                do {
                    let me = try await self.auth.me()
                    self.session = me
                    self.store?.setOffline(false)
                    await self.store?.refresh()
                    return
                } catch let e as APIError where e == .sessionEnded || e.statusCode == 401 || e.statusCode == 403 {
                    return   // onSessionEnded already handled it
                } catch { continue }
            }
        }
    }

    // MARK: Sign in flows

    func signInWithPassword() async {
        await runAuth { try await self.auth.login(address: self.signIn.address, password: self.signIn.password) }
    }

    func requestCode() async {
        signIn.busy = true; signIn.error = nil
        do {
            try await auth.requestCode(address: signIn.address)
            signIn.step = .codeEntry
            signIn.info = "If that mailbox exists, a sign-in code has been sent to its recovery email."
        } catch { signIn.error = message(error) }
        signIn.busy = false
    }

    func verifyCode() async {
        await runAuth { try await self.auth.verifyCode(address: self.signIn.address, code: self.signIn.code) }
    }

    func verifySecondFactor() async {
        await runAuth { try await self.auth.verifySecondFactor(code: self.signIn.code) }
    }

    func emailSecondFactor() async {
        signIn.busy = true; signIn.error = nil
        do { try await auth.emailSecondFactor(); signIn.info = "A code was sent to your account email." }
        catch { signIn.error = message(error) }
        signIn.busy = false
    }

    private func runAuth(_ work: @escaping () async throws -> LoginOutcome) async {
        signIn.busy = true; signIn.error = nil; signIn.info = nil
        defer { signIn.busy = false }
        do {
            switch try await work() {
            case let .signedIn(s):
                // Identity details (display name, institution) come from /me.
                let me = (try? await auth.me()) ?? s
                finishSignIn(me)
                signIn.reset()
            case .secondFactor:
                signIn.step = .secondFactor; signIn.code = ""; signIn.password = ""
            }
        } catch { signIn.error = message(error) }
    }

    func message(_ error: Error) -> String {
        if let api = error as? APIError {
            switch api.statusCode {
            case 401: return "Invalid address or password"
            case 423: return "This mailbox is temporarily locked. Try again later."
            case 429: return "Too many attempts. Wait a minute and try again."
            default: break
            }
            if api.code == "mfa_enrolment_required" { return AuthMessages.mfaEnrolment }
            if api.code == "onboarding_required" { return AuthMessages.onboarding }
            return api.errorDescription ?? "Something went wrong."
        }
        return error.localizedDescription
    }

    // MARK: Session

    func finishSignIn(_ s: MailboxSession, offline: Bool = false) {
        session = s
        if s.needsWebSetup && !offline {
            var steps: [String] = []
            if s.mustChangePassword == true { steps.append("choose your own password") }
            if s.needsRecoveryEmail == true { steps.append("add a recovery email address") }
            setupDetail = "Before you can read mail here, " + steps.joined(separator: " and ") + " on the web."
            phase = .setupRequired
            return
        }
        if let data = try? JSONEncoder().encode(s) { _ = secrets.write("identity", data) }
        cookies.saveNow()
        Task { _ = secrets.write(CacheKey.name, await cache.keyData) }   // after a sign out the cache has a fresh key
        let svc = LiveMailService(api: api, mailboxId: s.mailboxId)
        let st = MailStore(service: svc, cache: cache)
        wire(st)
        st.ownAddress = s.address
        retryTask?.cancel()
        // Ask for notification permission once the user is in their mailbox, not at launch.
        notifications.requestAuthorizationIfNeeded()
        if offline { st.setOffline(true) }
        store = st
        phase = .signedIn
        sessionBanner = nil
        Task { await st.bootstrap() }
        Task { switchable = (try? await auth.switchable()) ?? [] }
        startRealtime()
    }

    /// "Check again" on the setup screen: proceeds as soon as the flags clear.
    func recheckSetup() async {
        do { let me = try await auth.me(); finishSignIn(me) }
        catch { setupDetail = (error as? LocalizedError)?.errorDescription ?? setupDetail }
    }

    private func wire(_ st: MailStore) {
        st.onBadgeChange = { [weak self] n in self?.notifications.updateBadge(n) }
        st.onNewMail = { [weak self] fresh in self?.notifications.notify(fresh) }
    }

    func switchMailbox(to id: String) async {
        guard id != session?.mailboxId else { return }
        do {
            let s = try await auth.switchTo(id)
            realtime?.stop()
            await cache.clear(mailbox: session?.mailboxId ?? "")
            let me = (try? await auth.me()) ?? s
            session = me
            if let data = try? JSONEncoder().encode(me) { _ = secrets.write("identity", data) }
            let svc = LiveMailService(api: api, mailboxId: me.mailboxId)
            AttachmentFiles.purge()
            store?.swapService(svc)
            store?.ownAddress = me.address
            cookies.saveNow()
            Task { await store?.bootstrap() }
            Task { switchable = (try? await auth.switchable()) ?? [] }
            startRealtime()
        } catch { store?.post(message(error), isError: true) }
    }

    func signOut() async {
        realtime?.stop(); pollTask?.cancel()
        if !isPreview { await auth.logout() }
        await wipeLocalState()
        signIn.reset()
        phase = .signedOut
    }

    private func sessionEnded() {
        guard phase == .signedIn, !isPreview else { return }
        realtime?.stop(); pollTask?.cancel()
        Task {
            await wipeLocalState()
            sessionBanner = "Your session ended. Sign in again."
            phase = .signedOut
        }
    }

    /// Nothing readable stays behind: cookies, identity, mail cache, badge.
    private func wipeLocalState() async {
        await api.clearCookies()
        cookies.wipe()
        secrets.delete("identity")
        await cache.clearAll()
        secrets.delete("cache-key")
        AttachmentFiles.purge()
        ImageLoader.shared.clearCache()
        retryTask?.cancel()
        notifications.clearBadge()
        session = nil; store = nil; switchable = []
    }

    // MARK: Realtime and polling

    private func startRealtime() {
        guard !isPreview, let id = session?.mailboxId else { return }
        realtime?.stop(); pollTask?.cancel()
        mailboxBox.value = id
        let box = mailboxBox
        let rt = RealtimeClient(api: api, mailboxId: { box.value })
        rt.onConnection = { [weak self] on in Task { @MainActor in self?.realtimeConnected = on } }
        rt.onEvent = { [weak self] e in Task { @MainActor in self?.store?.handle(e) } }
        rt.onAuthFailure = { [weak self] in
            guard let self else { return false }
            return (try? await self.auth.me()) != nil
        }
        realtime = rt
        rt.start()
        // REST reconcile while the socket is down.
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard let self, !self.realtimeConnected else { continue }
                self.store?.handle(.reconcile)
            }
        }
    }

    /// Opens the thread of a clicked notification: recreate the main window if it was closed, load the
    /// folder, then select the message (no fixed sleeps).
    private func openFromNotification(folder: String, uid: Int) {
        guard let st = store else { return }
        NSApp.activate(ignoringOtherApps: true)
        if !NSApp.windows.contains(where: { $0.canBecomeMain && $0.isVisible }) { openMainWindow?() }
        Task {
            if st.selectedFolder != folder || st.isSearching { await st.endSearch(); st.selectFolder(folder) }
            await st.loadFirstPage(useCache: false, keepRows: true)
            if let row = st.rows.first(where: { $0.latest.uid == uid && $0.latest.folder == folder }) { st.select(row.id) }
        }
    }
}

final class SendableBox<T>: @unchecked Sendable {
    var value: T
    init(_ v: T) { value = v }
}
