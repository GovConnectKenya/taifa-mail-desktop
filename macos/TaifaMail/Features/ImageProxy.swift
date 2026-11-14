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
            let u = ns.substring(with: m.range(at: 2))
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

    /// Replaces each remote source that `fetch` could load with a data URI; the rest are left (the rule list blocks them).
    static func rewrite(html: String, fetch: (String) async -> Data?) async -> String {
        var out = html
        for src in remoteSources(in: html) {
            guard let data = await fetch(src), data.count <= maxBytes, let m = mime(for: data) else { continue }
            let uri = "data:\(m);base64,\(data.base64EncodedString())"
            out = out.replacingOccurrences(of: "\"\(src)\"", with: "\"\(uri)\"").replacingOccurrences(of: "'\(src)'", with: "'\(uri)'")
        }
        return out
    }
}
