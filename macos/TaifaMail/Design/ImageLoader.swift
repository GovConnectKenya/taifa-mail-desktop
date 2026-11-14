import AppKit
import ImageIO
import Observation

/// Loads avatar and logo images: disk backed URLCache, in memory NSCache of decoded images,
/// decoding and downsampling off the main thread.
final class ImageLoader: @unchecked Sendable {
    static let shared = ImageLoader()
    private let cache = NSCache<NSString, NSImage>()
    private let session: URLSession
    private var inflight: [String: Task<NSImage?, Never>] = [:]
    private let lock = NSLock()
    var baseURL = APIClient.productionBase
    #if DEBUG
    /// Debug preview only: serves generated images for fixture URLs.
    var fixtureData: ((String) -> Data?)?
    #endif

    init() {
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 128 << 20, directory: FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("TaifaMail/Images"))
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        session = URLSession(configuration: cfg)
        cache.countLimit = 600
    }

    func cached(_ urlString: String, maxPixel: Int) -> NSImage? { cache.object(forKey: key(urlString, maxPixel)) }
    private func key(_ u: String, _ m: Int) -> NSString { "\(m)|\(u)" as NSString }

    func load(_ urlString: String, maxPixel: Int) async -> NSImage? {
        let k = key(urlString, maxPixel)
        if let hit = cache.object(forKey: k) { return hit }
        #if DEBUG
        if let data = fixtureData?(urlString), let img = Self.downsample(data, maxPixel: maxPixel) { cache.setObject(img, forKey: k); return img }
        #endif
        lock.lock()
        if let t = inflight[k as String] { lock.unlock(); return await t.value }
        let task = Task.detached(priority: .utility) { [session, baseURL] () -> NSImage? in
            guard let url = URL(string: urlString, relativeTo: baseURL)?.absoluteURL,
                  url.scheme == "https" || url.scheme == "http",
                  let (data, resp) = try? await session.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { return nil }
            return Self.downsample(data, maxPixel: maxPixel)
        }
        inflight[k as String] = task
        lock.unlock()
        let image = await task.value
        lock.lock(); inflight[k as String] = nil; lock.unlock()
        if let image { cache.setObject(image, forKey: k) }
        return image
    }

    static func downsample(_ data: Data, maxPixel: Int) -> NSImage? {
        let opts: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let src = CGImageSourceCreateWithData(data as CFData, opts as CFDictionary) else { return nil }
        let thumb: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumb as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}

/// Resolves sender avatars in batches (POST /avatars/batch, at most 100 addresses per call).
@MainActor @Observable
final class AvatarStore {
    private(set) var entries: [String: AvatarEntry] = [:]
    @ObservationIgnored private var requested: Set<String> = []
    @ObservationIgnored private var queue: [String] = []
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored var service: MailService?

    func reset() { entries = [:]; requested = []; queue = []; flushTask?.cancel() }

    func request(_ address: String) {
        let key = address.lowercased()
        guard !key.isEmpty, !requested.contains(key) else { return }
        requested.insert(key)
        queue.append(key)
        if flushTask == nil {
            flushTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 120_000_000)
                await self?.flush()
            }
        }
    }

    private func flush() async {
        flushTask = nil
        let batch = Array(queue.prefix(100))
        queue.removeFirst(batch.count)
        guard !batch.isEmpty, let service else { return }
        do {
            let result = try await service.avatars(emails: batch)
            for e in batch { entries[e] = result[e] ?? AvatarEntry(url: nil, name: nil, urlScope: nil, institution: nil) }
        } catch {
            // Leave unresolved: the placeholder stays, and a later request may retry.
            for e in batch { requested.remove(e) }
        }
        if !queue.isEmpty { flushTask = Task { [weak self] in await self?.flush() } }
    }

    func entry(_ address: String) -> AvatarEntry? { entries[address.lowercased()] }
}
