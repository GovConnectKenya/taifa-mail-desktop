import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Rich text editor on NSTextView: bold, italic, lists and links.
@MainActor
final class RichTextController {
    weak var textView: NSTextView?

    func toggle(_ trait: NSFontTraitMask) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        let fm = NSFontManager.shared
        if range.length == 0 {
            let font = (tv.typingAttributes[.font] as? NSFont) ?? .systemFont(ofSize: 14)
            let has = fm.traits(of: font).contains(trait)
            tv.typingAttributes[.font] = has ? fm.convert(font, toNotHaveTrait: trait) : fm.convert(font, toHaveTrait: trait)
            return
        }
        guard let storage = tv.textStorage else { return }
        var allHave = true
        storage.enumerateAttribute(.font, in: range) { v, _, _ in
            if let f = v as? NSFont, !fm.traits(of: f).contains(trait) { allHave = false }
        }
        storage.beginEditing()
        storage.enumerateAttribute(.font, in: range) { v, r, _ in
            let f = (v as? NSFont) ?? .systemFont(ofSize: 14)
            storage.addAttribute(.font, value: allHave ? fm.convert(f, toNotHaveTrait: trait) : fm.convert(f, toHaveTrait: trait), range: r)
        }
        storage.endEditing()
        tv.didChangeText()
    }

    /// Real lists: NSTextList paragraph styles, which export to <ul>/<ol> in HTML.
    func bullets(numbered: Bool) {
        guard let tv = textView, let storage = tv.textStorage else { return }
        let list = NSTextList(markerFormat: numbered ? .decimal : .disc, options: 0)
        let ns = storage.string as NSString
        let range = ns.lineRange(for: tv.selectedRange())
        var paragraphs: [NSRange] = []
        ns.enumerateSubstrings(in: range, options: .byParagraphs) { _, r, _, _ in paragraphs.append(r) }
        if paragraphs.isEmpty { paragraphs = [range] }
        storage.beginEditing()
        var item = 0
        for r in paragraphs.reversed() {
            let current = (storage.attribute(.paragraphStyle, at: min(r.location, max(0, storage.length - 1)), effectiveRange: nil) as? NSParagraphStyle) ?? .default
            let ps = current.mutableCopy() as! NSMutableParagraphStyle
            if ps.textLists.isEmpty {
                ps.textLists = [list]; ps.headIndent = 36; ps.firstLineHeadIndent = 18
                ps.tabStops = [NSTextTab(textAlignment: .left, location: 18), NSTextTab(textAlignment: .left, location: 36)]
                item += 1
                let marker = "\t" + list.marker(forItemNumber: paragraphs.count - paragraphs.firstIndex(of: r)!) + "\t"
                storage.replaceCharacters(in: NSRange(location: r.location, length: 0), with: marker)
                storage.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: r.location, length: r.length + marker.count))
            } else {
                ps.textLists = []; ps.headIndent = 0; ps.firstLineHeadIndent = 0
                storage.addAttribute(.paragraphStyle, value: ps, range: r)
            }
        }
        storage.endEditing()
        tv.didChangeText()
    }

    func link() {
        guard let tv = textView else { return }
        let alert = NSAlert()
        alert.messageText = "Add link"
        alert.informativeText = "Address of the link"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = "https://"
        alert.accessoryView = field
        alert.addButton(withTitle: "Add"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn, let url = URL(string: field.stringValue), ["http", "https", "mailto"].contains(url.scheme ?? "") else { return }
        let r = tv.selectedRange()
        if r.length == 0 {
            tv.insertText(NSAttributedString(string: url.absoluteString, attributes: [.link: url, .font: NSFont.systemFont(ofSize: 14)]), replacementRange: r)
        } else { tv.textStorage?.addAttribute(.link, value: url, range: r); tv.didChangeText() }
    }
}

struct RichTextEditor: NSViewRepresentable {
    let controller: RichTextController
    let initial: NSAttributedString
    var onChange: (NSAttributedString) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        tv.isRichText = true
        tv.allowsUndo = true
        tv.importsGraphics = false
        tv.isAutomaticLinkDetectionEnabled = true
        tv.isAutomaticSpellingCorrectionEnabled = true
        tv.font = ComposeFont.body
        tv.typingAttributes[.font] = ComposeFont.body
        tv.textColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0xECECEC) : .black }
        tv.textContainerInset = NSSize(width: 12, height: 12)
        tv.drawsBackground = false
        tv.delegate = context.coordinator
        tv.textStorage?.setAttributedString(initial)
        tv.setSelectedRange(NSRange(location: 0, length: 0))
        tv.setAccessibilityIdentifier("compose-body")
        scroll.drawsBackground = false
        controller.textView = tv
        DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) { context.coordinator.onChange = onChange }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onChange: (NSAttributedString) -> Void
        init(_ c: @escaping (NSAttributedString) -> Void) { onChange = c }
        func textDidChange(_ n: Notification) { if let tv = n.object as? NSTextView { onChange(tv.attributedString()) } }
    }
}

/// To, Cc, Bcc: address chips plus an input with suggestions.
struct TokenField: View {
    let label: String
    @Binding var tokens: [String]
    var suggestions: [String]
    var onInput: (String) -> Void
    var onCommit: () -> Void
    @State private var input = ""

    var body: some View {
        HStack(alignment: .top, spacing: Space.s2) {
            Text(label).taifa(.meta).foregroundStyle(Theme.text3).frame(width: 40, alignment: .trailing).padding(.top, Space.s1)
            FlowLayout(spacing: Space.s1) {
                ForEach(tokens, id: \.self) { t in
                    HStack(spacing: Space.s1) {
                        Text(t).font(.taifaMono(12)).foregroundStyle(Address.isValid(t) ? Theme.text : Theme.dangerFg).lineLimit(1)
                        Button { tokens.removeAll { $0 == t }; onCommit() } label: { Icon(.close, size: 12) }.buttonStyle(.plain)
                            .accessibilityLabel("Remove \(t)")
                    }
                    .padding(.horizontal, Space.s2).frame(height: Metrics.chip)
                    .background(Address.isValid(t) ? Theme.panel3 : Theme.dangerSoft, in: Capsule())
                }
                TextField("", text: $input)
                    .textFieldStyle(.plain).taifa(.body).frame(minWidth: 140, minHeight: Metrics.chip)
                    .accessibilityLabel(label)
                    .accessibilityIdentifier("compose-\(label.lowercased())")
                    .onChange(of: input) { _, v in
                        if v.contains(",") || v.contains(";") || v.contains(" ") && Address.isValid(v.trimmingCharacters(in: .whitespaces)) { commit() } else { onInput(v) }
                    }
                    .onSubmit { commit() }
            }
        }
        .padding(.vertical, Space.s1)
        .overlay(alignment: .bottomLeading) {
            if !suggestions.isEmpty && !input.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(suggestions, id: \.self) { s in
                        Button { input = s; commit() } label: { Text(s).font(.taifaMono(12)).padding(.horizontal, Space.s3).frame(height: 28).frame(maxWidth: .infinity, alignment: .leading) }
                            .buttonStyle(.plain)
                    }
                }
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.ctl))
                .overlay(RoundedRectangle(cornerRadius: Radius.ctl).strokeBorder(Theme.border2))
                .frame(width: 320).offset(x: 48, y: 4 + CGFloat(suggestions.count) * 28).zIndex(10)
            }
        }
        .zIndex(1)
    }

    private func commit() {
        for a in Address.parse(input) where !tokens.contains(a) { tokens.append(a) }
        input = ""
        onInput("")
        onCommit()
    }
}

struct ComposeView: View {
    @Bindable var model: ComposeModel
    var signature: String?
    @Environment(\.dismiss) private var dismiss
    @State private var controller = RichTextController()
    @State private var ready = false
    @State private var dropping = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New message").font(Fonts.sans(16, .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
                Spacer()
                if !model.saveState.isEmpty { Text(model.saveState).taifa(.meta).foregroundStyle(Theme.text3) }
            }
            .padding(.horizontal, Space.s4).frame(height: 48).background(Theme.panel2)
            Divider().overlay(Theme.border)
            VStack(spacing: 0) {
                row { HStack(spacing: Space.s2) { Text("From").taifa(.meta).foregroundStyle(Theme.text3).frame(width: 40, alignment: .trailing)
                    Text(model.from).font(.taifaMono(12)).foregroundStyle(Theme.text2); Spacer() } }
                Divider().overlay(Theme.border)
                TokenField(label: "To", tokens: $model.to, suggestions: model.suggestions, onInput: model.suggest) { model.scheduleAutosave() }
                if model.showCc { Divider().overlay(Theme.border); TokenField(label: "Cc", tokens: $model.cc, suggestions: model.suggestions, onInput: model.suggest) { model.scheduleAutosave() } }
                if model.showBcc { Divider().overlay(Theme.border); TokenField(label: "Bcc", tokens: $model.bcc, suggestions: model.suggestions, onInput: model.suggest) { model.scheduleAutosave() } }
                Divider().overlay(Theme.border)
                row {
                    HStack(spacing: Space.s2) {
                        Text("Subject").taifa(.meta).foregroundStyle(Theme.text3).frame(width: 40, alignment: .trailing)
                        TextField("", text: $model.subject).textFieldStyle(.plain).taifa(.body)
                            .accessibilityIdentifier("compose-subject")
                            .onChange(of: model.subject) { _, _ in model.scheduleAutosave() }
                        if !model.showCc { Button("Cc") { model.showCc = true }.buttonStyle(QuietButtonStyle()) }
                        if !model.showBcc { Button("Bcc") { model.showBcc = true }.buttonStyle(QuietButtonStyle()) }
                    }
                }
            }
            .padding(.horizontal, Space.s4).padding(.top, Space.s2)
            Divider().overlay(Theme.border)
            toolbar
            if ready {
                RichTextEditor(controller: controller, initial: model.attributed) { model.attributed = $0; model.scheduleAutosave() }
            } else {
                VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<5, id: \.self) { _ in SkeletonBar(height: 10) } }.padding(Space.s4); Spacer()
            }
            if !model.attachments.isEmpty { attachmentStrip }
            if case let .failed(m) = model.status { Banner(kind: .danger, icon: .danger, message: m).padding(Space.s3) }
            if let n = model.notice { Banner(kind: .warn, icon: .warning, message: n).padding(Space.s3) }
            footer
        }
        .background(Theme.panel)
        .overlay { if dropping { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.accentFg, style: StrokeStyle(lineWidth: 2, dash: [6])).padding(Space.s2).allowsHitTesting(false) } }
        .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
            for p in providers { _ = p.loadObject(ofClass: URL.self) { url, _ in if let url { Task { @MainActor in model.addFiles([url]) } } } }
            return true
        }
        .task { await model.prepare(signature: signature); ready = true }
        .onDisappear { if model.status != .sent && !model.discarded { Task { await model.saveDraft() } } }
        .frame(minWidth: 520, minHeight: 440)
    }

    private func row<C: View>(@ViewBuilder _ c: () -> C) -> some View { c().frame(minHeight: 40) }

    private var toolbar: some View {
        HStack(spacing: Space.s1) {
            Button { controller.toggle(.boldFontMask) } label: { Text("B").font(Fonts.sans(13, .semibold)).frame(width: 28, height: 24) }.help("Bold").accessibilityLabel("Bold")
            Button { controller.toggle(.italicFontMask) } label: { Text("I").font(Fonts.sans(13).italic()).frame(width: 28, height: 24) }.help("Italic").accessibilityLabel("Italic")
            Button { controller.bullets(numbered: false) } label: { Icon(.list, size: 16).frame(width: 28, height: 24) }.help("Bulleted list").accessibilityLabel("Bulleted list")
            Button { controller.bullets(numbered: true) } label: { Text("1.").font(Fonts.mono(12, .semibold)).frame(width: 28, height: 24) }.help("Numbered list").accessibilityLabel("Numbered list")
            Button { controller.link() } label: { Icon(.link, size: 16).frame(width: 28, height: 24) }.help("Add link").accessibilityLabel("Add link")
            Spacer()
            IconButton(icon: .attachment, label: "Attach files") { pick() }
        }
        .buttonStyle(.plain).foregroundStyle(Theme.text2)
        .padding(.horizontal, Space.s4).frame(height: 40)
        .background(Theme.panel2)
    }

    private var attachmentStrip: some View {
        FlowLayout(spacing: Space.s2) {
            ForEach(model.attachments) { a in
                HStack(spacing: Space.s2) {
                    Icon(.attachment, size: 14)
                    Text(a.name).taifa(.meta).lineLimit(1)
                    switch a.state {
                    case .uploading: ProgressView().controlSize(.mini)
                    case .ready: Text(ByteCountFormatter.string(fromByteCount: Int64(a.size), countStyle: .file)).taifa(.caption).foregroundStyle(Theme.text3)
                    case .failed(let m): Text(m).taifa(.caption).foregroundStyle(Theme.dangerFg)
                    }
                    Button { model.removeAttachment(a.id) } label: { Icon(.close, size: 12) }.buttonStyle(.plain).accessibilityLabel("Remove \(a.name)")
                }
                .padding(.horizontal, Space.s3).frame(height: 32)
                .background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl))
            }
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .accessibilityIdentifier("compose-attachments")
    }

    private var footer: some View {
        HStack {
            Button { Task { await model.discard(); dismiss() } } label: { HStack(spacing: Space.s2) { Icon(.trash, size: 16); Text("Discard") } }
                .buttonStyle(QuietButtonStyle()).accessibilityIdentifier("compose-discard")
            Spacer()
            Button {
                Task { if await model.send() { dismiss() } }
            } label: {
                HStack(spacing: Space.s2) {
                    if model.status == .sending { ProgressView().controlSize(.small).tint(.white) } else { Icon(.send, size: 16) }
                    Text(model.status == .sending ? "Sending" : "Send")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .disabled(!model.canSend)
            .accessibilityIdentifier("compose-send")
        }
        .padding(Space.s3)
        .background(Theme.panel)
        .overlay(alignment: .top) { Divider().overlay(Theme.border) }
    }

    private func pick() {
        let p = NSOpenPanel(); p.allowsMultipleSelection = true; p.canChooseDirectories = false
        if p.runModal() == .OK { model.addFiles(p.urls) }
    }
}
