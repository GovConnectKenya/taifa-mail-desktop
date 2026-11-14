import Foundation
import WebKit

/// The only web content in the app is the HTML body of a received message. This type is the single
/// place that decides how locked down that view is (docs/native/DESIGN_SPEC.md section 13).
enum BodyLockdown {
    static let ruleListIdentifier = "ke.govconnect.taifamail.block-remote"

    /// Blocks every http and https load (images, CSS imports, fonts, frames, scripts) until the user allows images.
    static let blockAllRemoteRulesJSON = """
    [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]
    """

    /// Navigation inside the view is never allowed. Returns what to do with a navigation request.
    enum NavigationDecision: Equatable {
        case allow            // the initial load of our own HTML
        case cancel
        case openExternally(URL)
    }

    static func decide(navigationType: WKNavigationType, url: URL?) -> NavigationDecision {
        let isOwnDocument = url == nil || url?.scheme == "about"
        switch navigationType {
        case .other, .reload:
            // Only the initial load of our own HTML (about:blank base). Redirects, meta refresh and scripts are cancelled.
            return isOwnDocument ? .allow : .cancel
        case .linkActivated:
            guard let url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return .cancel }
            return .openExternally(url)
        default:
            return .cancel
        }
    }

    /// What the visible host check shows before a link leaves the app.
    struct LinkCheck: Equatable {
        var url: URL
        var host: String          // as the system will use it (punycode form kept in `rawHost`)
        var rawHost: String
        var isUnicodeHost: Bool   // internationalised name: show both forms
        var scheme: String
    }

    static func linkCheck(_ url: URL) -> LinkCheck {
        let raw = (url.host ?? "").lowercased()
        let decoded = raw
        return LinkCheck(url: url, host: url.scheme == "mailto" ? url.absoluteString.replacingOccurrences(of: "mailto:", with: "") : decoded,
                         rawHost: raw, isUnicodeHost: raw.contains("xn--"), scheme: url.scheme ?? "")
    }

    /// Builds the web view configuration. `allowRemoteImages` only controls the content rule list;
    /// JavaScript, persistence and navigation stay locked in every mode.
    static func makeConfiguration(ruleList: WKContentRuleList?, allowRemoteImages: Bool) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        config.defaultWebpagePreferences = prefs
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.suppressesIncrementalRendering = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        if !allowRemoteImages, let ruleList { config.userContentController.add(ruleList) }
        return config
    }

    @MainActor static func compileRules() async -> WKContentRuleList? {
        try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: ruleListIdentifier, encodedContentRuleList: blockAllRemoteRulesJSON)
    }

    /// The document shown in the view. `allowRemoteImages` also widens the CSP image source (defence in depth).
    static func document(html: String, allowRemoteImages: Bool) -> String {
        let imgSrc = allowRemoteImages ? "data: cid: https: http:" : "data: cid:"
        let csp = "default-src 'none'; img-src \(imgSrc); style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'"
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(csp)">
        <meta name="color-scheme" content="light dark">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; background: transparent; }
        body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; color: #050100; overflow-wrap: anywhere; word-break: normal; }
        @media (prefers-color-scheme: dark) { body { color: #F8F3F0; } a { color: #1EA94E; } }
        img { max-width: 100%; height: auto; }
        table { max-width: 100%; }
        pre { white-space: pre-wrap; }
        blockquote { margin: 8px 0 8px 4px; padding-left: 12px; border-left: 2px solid rgba(128,128,128,.4); }
        </style></head><body>\(html)</body></html>
        """
    }

    /// True when the HTML references a remote image or stylesheet (decides whether to offer "Show images").
    static func hasRemoteContent(_ html: String) -> Bool {
        html.range(of: #"(src|background|href)\s*=\s*["']?https?://[^"'>\s]*\.(png|jpe?g|gif|webp|svg)|<img[^>]+src\s*=\s*["']?https?://|url\(\s*["']?https?://"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }
}
