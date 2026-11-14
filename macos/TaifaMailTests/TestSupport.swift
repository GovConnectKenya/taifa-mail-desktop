import Foundation
import XCTest
@testable import TaifaMail

enum Fixture {
    static func data(_ name: String) -> Data {
        let url = Bundle(for: BundleToken.self).url(forResource: name, withExtension: "json")!
        return try! Data(contentsOf: url)
    }
    static func decode<T: Decodable>(_ type: T.Type, _ name: String) -> T { try! Coding.decoder().decode(T.self, from: data(name)) }
    private final class BundleToken {}
}

/// URLProtocol that answers from a closure and records requests.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data, [String: String]))?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    static func reset() { handler = nil; requests = [] }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let (status, data, headers) = Self.handler?(request) ?? (500, Data(), [:])
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class StubService: MailService, @unchecked Sendable {
    let mailboxId = "mb1"
    var markRead: (Int, String) async throws -> MarkReadResult = { _, _ in MarkReadResult(marked: 1, folders: [:], uids: [:], complete: true, failedFolders: []) }
    var batchHandler: (BatchAction, [Int], String) async throws -> BatchResult = { _, u, _ in BatchResult(ok: true, requested: u.count, succeeded: u, failed: []) }
    var conversationsResult = ConversationList(folder: "INBOX", total: 0, limit: 50, offset: 0, items: [])
    var batches: [(BatchAction, [Int], String)] = []
    var fileStatuses: [StoredFile] = []
    var fileStatusCalls = 0
    var saveDraftCalls = 0
    var sendCalls = 0
    var sendHandler: () async throws -> SendResult = { SendResult(ok: true, messageId: "x") }
    var conversationsDelay: UInt64 = 0

    func folders() async throws -> [Folder] { Fixture.decode([Folder].self, "folders") }
    func folderCounts() async throws -> [FolderCount] { [] }
    func quota() async throws -> Quota? { nil }
    func conversations(folder: String, offset: Int, limit: Int) async throws -> ConversationList {
        if conversationsDelay > 0 { try await Task.sleep(nanoseconds: conversationsDelay) }
        return conversationsResult
    }
    func messages(folder: String, offset: Int, limit: Int) async throws -> MessageList { MessageList(folder: folder, total: 0, limit: limit, offset: offset, items: []) }
    func search(query: String, folder: String, offset: Int, limit: Int) async throws -> MessageList { MessageList(folder: folder, total: 0, limit: limit, offset: offset, items: []) }
    func conversation(uid: Int, folder: String, before: Int?) async throws -> ConversationWindow { Fixture.decode(ConversationWindow.self, "conversation_window") }
    func body(uid: Int, folder: String) async throws -> ThreadMessage { Fixture.decode(ConversationWindow.self, "conversation_window").messages[1] }
    func markThreadRead(uid: Int, folder: String) async throws -> MarkReadResult { try await markRead(uid, folder) }
    func batch(action: BatchAction, uids: [Int], folder: String) async throws -> BatchResult {
        batches.append((action, uids, folder)); return try await batchHandler(action, uids, folder)
    }
    func resolve(messageId: String, hint: String) async throws -> ResolvedMessage { ResolvedMessage(folder: hint, uid: 1) }
    func avatars(emails: [String]) async throws -> [String: AvatarEntry] { [:] }
    func attachment(uid: Int, folder: String, partId: String) async throws -> Data { Data() }
    func send(_ payload: Endpoints.SendPayload) async throws -> SendResult { sendCalls += 1; return try await sendHandler() }
    func saveDraft(_ payload: Endpoints.SendPayload) async throws -> DraftResult { saveDraftCalls += 1; return DraftResult(uid: 1, folder: "Drafts") }
    func upload(filename: String, mime: String, data: Data) async throws -> StoredFile { StoredFile(id: "f", filename: filename, mime: mime, sizeBytes: data.count, status: "ready", scanVerdict: nil) }
    func contacts(matching: String) async throws -> [Contact] { [] }
    func stageAttachments(uid: Int, folder: String) async throws -> [StagedAttachment] { [] }
    func proxiedImage(_ url: String) async -> Data? { nil }
    func fileStatus(_ id: String) async throws -> StoredFile {
        fileStatusCalls += 1
        return fileStatuses.isEmpty ? StoredFile(id: id, filename: "f", mime: nil, sizeBytes: 1, status: "ready", scanVerdict: nil) : fileStatuses.removeFirst()
    }
    func signature() async throws -> MailBlock? { nil }
    func saveSignature(html: String, text: String, existing: MailBlock?) async throws {}
    func autoResponder() async throws -> AutoResponder { .empty }
    func saveAutoResponder(_ a: AutoResponder) async throws {}
    func trustedImageSenders() async throws -> [String] { [] }
}
