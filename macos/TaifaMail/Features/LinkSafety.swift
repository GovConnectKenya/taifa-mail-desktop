import Foundation

/// RFC 3492 punycode, enough to show the Unicode form of an internationalised host and back.
enum Punycode {
    private static let base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128

    private static func adapt(_ delta: Int, _ numPoints: Int, _ first: Bool) -> Int {
        var d = first ? delta / damp : delta / 2
        d += d / numPoints
        var k = 0
        while d > ((base - tMin) * tMax) / 2 { d /= base - tMin; k += base }
        return k + (base - tMin + 1) * d / (d + skew)
    }

    private static func digit(_ c: Character) -> Int? {
        guard let a = c.asciiValue else { return nil }
        switch a { case 48...57: return Int(a) - 22; case 65...90: return Int(a) - 65; case 97...122: return Int(a) - 97; default: return nil }
    }

    /// Decodes one label (without the `xn--` prefix). Returns nil for malformed input or any overflow: this
    /// runs on attacker controlled hosts, so no arithmetic here may trap.
    static func decode(_ input: String) -> String? {
        guard input.unicodeScalars.allSatisfy(\.isASCII), input.utf8.count <= 256 else { return nil }
        var output: [UInt32] = []
        var rest = Substring(input)
        if let i = input.lastIndex(of: "-") {
            output = input[..<i].unicodeScalars.map { $0.value }
            rest = input[input.index(after: i)...]
        }
        var n = initialN, i = 0, bias = initialBias
        let chars = Array(rest)
        var idx = 0
        while idx < chars.count {
            let oldI = i; var w = 1; var k = base
            while true {
                guard idx < chars.count, let d = digit(chars[idx]) else { return nil }
                idx += 1
                let (dw, o1) = d.multipliedReportingOverflow(by: w)
                if o1 { return nil }
                let (ni, o2) = i.addingReportingOverflow(dw)
                if o2 { return nil }
                i = ni
                let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
                if d < t { break }
                let (nw, o3) = w.multipliedReportingOverflow(by: base - t)
                if o3 { return nil }
                w = nw
                let (nk, o4) = k.addingReportingOverflow(base)
                if o4 { return nil }
                k = nk
            }
            let count = output.count + 1
            bias = adapt(i - oldI, count, oldI == 0)
            let (nn, o5) = n.addingReportingOverflow(i / count)
            if o5 { return nil }
            n = nn; i %= count
            guard let scalarValue = UInt32(exactly: n), Unicode.Scalar(scalarValue) != nil else { return nil }
            output.insert(scalarValue, at: i); i += 1
        }
        return String(String.UnicodeScalarView(output.compactMap(Unicode.Scalar.init)))
    }

    /// Encodes one non-ASCII label (without prefix).
    static func encode(_ input: String) -> String? {
        let scalars = input.unicodeScalars.map { Int($0.value) }
        var output = input.unicodeScalars.filter { $0.isASCII }.map(Character.init)
        let b = output.count
        var h = b
        if b > 0 { output.append("-") }
        var n = initialN, delta = 0, bias = initialBias
        func ch(_ d: Int) -> Character { Character(Unicode.Scalar(UInt8(d < 26 ? d + 97 : d + 22))) }
        while h < scalars.count {
            guard let m = scalars.filter({ $0 >= n }).min() else { return nil }
            delta += (m - n) * (h + 1); n = m
            for c in scalars {
                if c < n { delta += 1 }
                if c == n {
                    var q = delta; var k = base
                    while true {
                        let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
                        if q < t { break }
                        output.append(ch(t + (q - t) % (base - t))); q = (q - t) / (base - t); k += base
                    }
                    output.append(ch(q)); bias = adapt(delta, h + 1, h == b); delta = 0; h += 1
                }
            }
            delta += 1; n += 1
        }
        return String(output)
    }

    static func toUnicode(host: String) -> String {
        host.split(separator: ".", omittingEmptySubsequences: false).map { l -> String in
            let s = String(l).lowercased()
            return s.hasPrefix("xn--") ? (decode(String(s.dropFirst(4))) ?? s) : s
        }.joined(separator: ".")
    }

    static func toASCII(host: String) -> String {
        host.split(separator: ".", omittingEmptySubsequences: false).map { l -> String in
            let s = String(l).lowercased()
            if s.unicodeScalars.allSatisfy(\.isASCII) { return s }
            return "xn--" + (encode(s) ?? s)
        }.joined(separator: ".")
    }
}

/// What the link prompt needs to tell the user the truth about where a link goes.
struct LinkAssessment: Equatable {
    var url: URL
    var asciiHost: String        // punycode form, what the browser connects to
    var unicodeHost: String      // what it looks like
    var showBothForms: Bool      // non-ASCII or mixed script host
    var mixedScript: Bool
    var textNamesOtherHost: Bool
    var visibleText: String?

    var title: String {
        url.scheme == "mailto" ? "Write to \(url.absoluteString.replacingOccurrences(of: "mailto:", with: ""))?" : "Open link to \(unicodeHost)?"
    }

    var message: String {
        var lines = [url.absoluteString]
        if showBothForms { lines.append("Shown as \(unicodeHost), real address \(asciiHost).") }
        if mixedScript { lines.append("Warning: this name mixes letters from different alphabets, a common trick to imitate another site.") }
        if textNamesOtherHost, let t = visibleText { lines.append("Warning: the link text says \"\(t)\" but it goes to \(unicodeHost).") }
        return lines.joined(separator: "\n")
    }
}

enum LinkSafety {
    /// Only these schemes may ever leave the app.
    static let allowedSchemes: Set<String> = ["http", "https", "mailto"]
    static func isAllowed(_ url: URL) -> Bool { allowedSchemes.contains(url.scheme?.lowercased() ?? "") }

    enum Script { case latin, cyrillic, greek, armenian, hebrew, arabic, cjk, other }

    static func script(of s: Unicode.Scalar) -> Script? {
        guard s.properties.isAlphabetic else { return nil }
        switch s.value {
        case 0x41...0x24F, 0x1E00...0x1EFF: return .latin
        case 0x370...0x3FF, 0x1F00...0x1FFF: return .greek
        case 0x400...0x52F: return .cyrillic
        case 0x530...0x58F: return .armenian
        case 0x590...0x5FF: return .hebrew
        case 0x600...0x6FF: return .arabic
        case 0x3040...0x30FF, 0x3400...0x9FFF, 0xAC00...0xD7AF: return .cjk
        default: return .other
        }
    }

    /// True when one label mixes scripts (for example Latin with Cyrillic lookalikes).
    static func mixesScripts(_ unicodeHost: String) -> Bool {
        unicodeHost.split(separator: ".").contains { label in
            Set(label.unicodeScalars.compactMap(script(of:))).count > 1
        }
    }

    static func assess(_ url: URL, visibleText: String? = nil) -> LinkAssessment {
        if url.scheme?.lowercased() == "mailto" {
            return LinkAssessment(url: url, asciiHost: "", unicodeHost: "", showBothForms: false, mixedScript: false, textNamesOtherHost: false, visibleText: nil)
        }
        let raw = (url.host ?? "").lowercased()
        let ascii = Punycode.toASCII(host: raw)
        let uni = Punycode.toUnicode(host: ascii)
        let nonASCII = ascii.contains("xn--") || raw.unicodeScalars.contains { !$0.isASCII }
        let mixed = mixesScripts(uni)
        return LinkAssessment(url: url, asciiHost: ascii, unicodeHost: uni, showBothForms: nonASCII || mixed, mixedScript: mixed,
                              textNamesOtherHost: textNamesOtherHost(visibleText, realHost: ascii), visibleText: visibleText)
    }

    /// Port of the Windows LinkSafety.TextNamesOtherHost: link text that looks like a host or URL, but not this link's.
    static func textNamesOtherHost(_ text: String?, realHost: String) -> Bool {
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return false }
        var candidate: String?
        if let u = URL(string: t), let scheme = u.scheme?.lowercased(), ["http", "https"].contains(scheme) { candidate = u.host }
        else if !t.contains(" "), t.contains("."), let u = URL(string: "https://" + t), let h = u.host, h.contains(".") { candidate = h }
        guard let c = candidate?.lowercased() else { return false }
        let a = Punycode.toASCII(host: c), b = realHost.lowercased()
        return !(a == b || a.hasSuffix("." + b) || b.hasSuffix("." + a))
    }

    /// Decodes the HTML entities that appear in attribute values (&amp; &quot; &#39; &#x27; &lt; &gt;).
    static func unescapeHTML(_ s: String) -> String {
        var out = s
        for (k, v) in [("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&")] { out = out.replacingOccurrences(of: k, with: v, options: .caseInsensitive) }
        return out
    }

    /// Canonical form for comparing two URLs: lowercase scheme and host, empty path equals "/", entities decoded.
    static func normalized(_ raw: String) -> String {
        let decoded = unescapeHTML(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: decoded) else { return decoded }
        c.scheme = c.scheme?.lowercased(); c.host = c.host?.lowercased()
        if c.path.isEmpty && c.host != nil { c.path = "/" }
        c.fragment = nil
        return c.string ?? decoded
    }

    /// Whether a click is allowed to reach the prompt at all (links_disabled and the scheme allowlist).
    static func shouldPrompt(_ url: URL, linksLocked: Bool) -> Bool { !linksLocked && isAllowed(url) }

    /// The visible text of the first anchor in `html` whose href equals `url` (the web view cannot tell us).
    static func visibleText(for url: URL, in html: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return nil }
        let ns = html as NSString
        let target = normalized(url.absoluteString)
        for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            guard normalized(ns.substring(with: m.range(at: 1))) == target else { continue }
            let inner = unescapeHTML(ns.substring(with: m.range(at: 2)).replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression))
            let t = inner.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return nil
    }
}
