import CryptoKit
import Foundation

/// One phone runtime script and its digest (SHA-256 of its UTF-8 bytes, hex), as the server
/// names its own (`getPhoneRuntime`).
struct RuntimeScript: Equatable {
    let source: String
    let digest: String

    init(source: String) {
        self.source = source
        digest = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// The runtime the phone runs: the server's when it handed one out, else the one the app was
/// built with. The app asks the server with the digest of the one it runs, so a server that runs
/// the same scripts answers with the digest alone, never the whole bundle (about 570 KB). The
/// server's runtime is kept in the app's caches, so the next launch runs it without downloading
/// it again; it is kept for the app's own build only, so a new build never runs a runtime an
/// older one was handed (the server hands it again if it still runs it).
struct RuntimeScripts {
    let bundled: RuntimeScript?
    private(set) var served: RuntimeScript?
    private let store: ServedRuntimeStore

    init(bundled: String?, store: ServedRuntimeStore) {
        let bundled = bundled.map(RuntimeScript.init(source:))
        self.bundled = bundled
        self.store = store
        served = bundled.flatMap { store.load(builtWith: $0.digest) }
    }

    /// The script that runs now.
    var running: RuntimeScript? {
        served ?? bundled
    }

    /// Takes what the server runs; `true` when the script that runs changed.
    mutating func take(_ remote: RemoteRuntime) -> Bool {
        guard remote.digest != running?.digest else { return false }
        if remote.digest == bundled?.digest {
            // The server went back to the app's own scripts.
            served = nil
            store.clear()
            return true
        }
        // A source that isn't the script the server named is never run.
        guard let source = remote.source else { return false }
        let script = RuntimeScript(source: source)
        guard script.digest == remote.digest else { return false }
        served = script
        if let bundled {
            store.save(script, builtWith: bundled.digest)
        }
        return true
    }
}

/// Keeps the server's runtime in a directory of the app's caches (iOS may empty it; the app's
/// own runtime runs then until the server hands its own again), named by the digest of the
/// runtime the app was built with.
struct ServedRuntimeStore {
    let directory: URL?

    static func caches() -> ServedRuntimeStore {
        ServedRuntimeStore(
            directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
                .appending(path: "PhoneRuntime", directoryHint: .isDirectory),
        )
    }

    /// The runtime kept for the build whose own runtime is `bundled`, if it is intact; any other
    /// build's is removed.
    func load(builtWith bundled: String) -> RuntimeScript? {
        guard let directory, let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path())
        else { return nil }
        let kept = Self.name(bundled)
        for name in names where name != kept {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
        guard let source = try? String(contentsOf: directory.appending(path: kept), encoding: .utf8) else { return nil }
        return RuntimeScript(source: source)
    }

    func save(_ script: RuntimeScript, builtWith bundled: String) {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data(script.source.utf8).write(to: directory.appending(path: Self.name(bundled)), options: .atomic)
    }

    func clear() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    private static func name(_ bundled: String) -> String {
        "served-for-\(bundled).js"
    }
}
