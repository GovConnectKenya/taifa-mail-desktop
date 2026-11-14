import Foundation

/// Remote images are never loaded by the web view. When the user allows them, the app fetches each one
/// through the server image proxy (so the sender never sees the officer's IP) and inlines it as a data URI.
enum ImageProxy {
    static let maxImages = 40
    static let maxBytes = 5 << 20

    static func base64URL(_ s: String) -> String {
        Data(s.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Remote `<img src>` values of an HTML body, in order, unique, http and https only.
    static func remoteSources(in html: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: #"<img\b[^>]*?\bsrc\s*=\s*(["'])(https?://[^"']+)\1"#, options: [.caseInsensitive]) else { return [] }
        let ns = html as NSString
        var seen = Set<String>(), out: [String] = []
        for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let u = LinkSafety.unescapeHTML(ns.substring(with: m.range(at: 2)))
            if seen.insert(u).inserted { out.append(u) }
        }
        return Array(out.prefix(maxImages))
    }

    static func mime(for data: Data) -> String? {
        let b = [UInt8](data.prefix(12))
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if b.count >= 12, b[0...3] == [0x52, 0x49, 0x46, 0x46], b[8...11] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        return nil   // SVG and everything else is refused: it can carry active content
    }

    /// Why an image was not inlined.
    enum Outcome: Equatable { case loaded(Data), rateLimited, failed }

    struct Result: Equatable { var html: String; var blocked: Int; var rateLimited: Bool }

    /// Replaces each remote source that `fetch` could load with a data URI, four at a time. The rest stay as they
    /// are (the rule list blocks them) and are counted so the UI can offer a retry.
    static func rewrite(html: String, concurrency: Int = 4, fetch: @escaping @Sendable (String) async -> Outcome) async -> Result {
        let sources = remoteSources(in: html)
        var inlined: [String: String] = [:]
        var blocked = 0, limited = false
        var index = 0
        while index < sources.count && !limited {
            let batch = Array(sources[index..<min(sources.count, index + concurrency)])
            index += batch.count
            let results = await withTaskGroup(of: (String, Outcome).self) { group -> [(String, Outcome)] in
                for src in batch { group.addTask { (src, await fetch(src)) } }
                var all: [(String, Outcome)] = []
                for await r in group { all.append(r) }
                return all
            }
            for (src, outcome) in results {
                switch outcome {
                case let .loaded(data):
                    if data.count <= maxBytes, let m = mime(for: data) { inlined[src] = "data:\(m);base64,\(data.base64EncodedString())" } else { blocked += 1 }
                case .rateLimited: limited = true; blocked += 1
                case .failed: blocked += 1
                }
            }
        }
        if limited { blocked += sources.count - index }   // never requested: shown blocked until retry
        var out = html
        for (src, uri) in inlined {
            // The HTML holds the escaped form (&amp;), the URL we fetched is the decoded one.
            for form in [src, src.replacingOccurrences(of: "&", with: "&amp;")] {
                out = out.replacingOccurrences(of: "\"\(form)\"", with: "\"\(uri)\"").replacingOccurrences(of: "'\(form)'", with: "'\(uri)'")
            }
        }
        return Result(html: out, blocked: blocked, rateLimited: limited)
    }
}

/// Caches the proxy capability per mailbox and refreshes it 5 minutes before it expires (webmail image-proxy.svelte.ts).
actor ImageProxyCapabilityCache {
    struct Capability: Equatable { var token: String; var expiresAt: Date }
    private var caps: [String: Capability] = [:]
    private var inflight: [String: Task<Capability?, Never>] = [:]
    static let refreshMargin: TimeInterval = 5 * 60

    func token(mailbox: String, now: Date = Date(), fetch: @escaping @Sendable () async -> Capability?) async -> String? {
        if let c = caps[mailbox], c.expiresAt > now.addingTimeInterval(Self.refreshMargin) { return c.token }
        if let t = inflight[mailbox] { return await t.value?.token }
        let task = Task { await fetch() }
        inflight[mailbox] = task
        let c = await task.value
        inflight[mailbox] = nil
        if let c { caps[mailbox] = c }
        return c?.token ?? caps[mailbox]?.token
    }
    func clear() { caps = [:] }
}
