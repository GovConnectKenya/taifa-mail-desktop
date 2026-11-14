import SwiftUI
import WebKit

final class PassthroughWebView: WKWebView {
    // The reader scrolls, not the message: wheel events go to the enclosing scroll view.
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}

/// Renders the HTML body of one received message in the locked down web view, sized to its content.
struct MessageBodyView: NSViewRepresentable {
    let html: String
    let allowRemoteImages: Bool
    @Binding var height: CGFloat
    var onLink: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = BodyLockdown.makeConfiguration(ruleList: Coordinator.sharedRules, allowRemoteImages: allowRemoteImages)
        let web = PassthroughWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false
        web.postsFrameChangedNotifications = true
        context.coordinator.observe(web)
        context.coordinator.loaded = (html, allowRemoteImages)
        web.loadHTMLString(BodyLockdown.document(html: html, allowRemoteImages: allowRemoteImages), baseURL: URL(string: "about:blank"))
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        let key = (html, allowRemoteImages)
        guard context.coordinator.loaded != key else { return }
        context.coordinator.loaded = key
        // A different configuration is needed when images get allowed: rebuild by reloading with the rule list removed.
        if allowRemoteImages { web.configuration.userContentController.removeAllContentRuleLists() }
        web.loadHTMLString(BodyLockdown.document(html: html, allowRemoteImages: allowRemoteImages), baseURL: URL(string: "about:blank"))
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        static var sharedRules: WKContentRuleList?
        var parent: MessageBodyView
        var loaded: (String, Bool) = ("", false)
        init(_ p: MessageBodyView) { parent = p }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
            preferences.allowsContentJavaScript = false
            switch BodyLockdown.decide(navigationType: navigationAction.navigationType, url: navigationAction.request.url) {
            case .allow: return (.allow, preferences)
            case .cancel: return (.cancel, preferences)
            case let .openExternally(url): parent.onLink(url); return (.cancel, preferences)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") { parent.onLink(url) }
            return nil
        }

        private var token: NSObjectProtocol?
        /// Remeasure when the width changes (window resize): reflowed text changes the content height.
        func observe(_ web: WKWebView) {
            token = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: web, queue: .main) { [weak self, weak web] _ in
                guard let self, let web else { return }
                MainActor.assumeIsolated { self.measure(web) }
            }
        }
        deinit { if let t = token { NotificationCenter.default.removeObserver(t) } }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { measure(webView) }

        func measure(_ web: WKWebView) {
            // The app's own script (not page script) reads the laid out height.
            web.evaluateJavaScript("Math.ceil(document.documentElement.scrollHeight)") { [weak self] result, _ in
                guard let h = result as? CGFloat ?? (result as? Double).map({ CGFloat($0) }), h > 0 else { return }
                DispatchQueue.main.async { if abs((self?.parent.height ?? 0) - h) > 1 { self?.parent.height = h } }
            }
        }
    }
}

/// Compiles the remote block rules once. The HTML view is only shown after this succeeded: if the
/// rules cannot be compiled the app falls back to plain text rather than rendering unprotected HTML.
@MainActor @Observable
final class BodyRules {
    static let shared = BodyRules()
    enum State { case preparing, ready, unavailable }
    private(set) var state: State = .preparing
    func prepare() async {
        guard state == .preparing else { return }
        if MessageBodyView.Coordinator.sharedRules == nil { MessageBodyView.Coordinator.sharedRules = await BodyLockdown.compileRules() }
        state = MessageBodyView.Coordinator.sharedRules == nil ? .unavailable : .ready
    }
}
