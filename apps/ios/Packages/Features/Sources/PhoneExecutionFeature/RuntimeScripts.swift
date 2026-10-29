import CryptoKit
import Foundation

/// One phone runtime script and its digest (SHA-256 of its UTF-8 bytes, hex), as the server
/// names its own (`getPhoneRuntime`). A runtime the server handed out also keeps the release
/// key's signature of it and the version that signature names (`RuntimeSignature`); the app's own
/// runtime has neither, since it came with the app.
struct RuntimeScript: Equatable {
    let source: String
    let digest: String
    /// The version its signature names, which the loaded runtime must say it speaks; nil for the
    /// app's own runtime.
    let runtimeVersion: Int?
    let signature: String?

    init(source: String, runtimeVersion: Int? = nil, signature: String? = nil) {
        self.source = source
        digest = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        self.runtimeVersion = runtimeVersion
        self.signature = signature
    }
}

/// The runtime the phone runs: the server's when it handed one out signed by Listora's release
/// key, else the one the app was built with. The app asks the server with the digest of the one
/// it runs, so a server that runs the same scripts answers with the digest alone, never the whole
/// bundle (about 570 KB). The server's runtime is kept in the app's caches, so the next launch runs
/// it without downloading it again (its signature checked again first); it is kept for the app's
/// own build only, so a new build never runs a runtime an older one was handed (the server hands
/// it again if it still runs it).
struct RuntimeScripts {
    let bundled: RuntimeScript?
    private(set) var served: RuntimeScript?
    private let store: ServedRuntimeStore
    private let signature: RuntimeSignature

    init(bundled: String?, store: ServedRuntimeStore, signature: RuntimeSignature = .release) {
        let bundled = bundled.map { RuntimeScript(source: $0) }
        self.bundled = bundled
        self.store = store
        self.signature = signature
        served = bundled.flatMap { store.load(builtWith: $0.digest, signature: signature) }
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
        // A source that isn't the script the server named is never run, and neither is one the
        // release key didn't sign: the phone keeps the runtime it runs.
        guard let source = remote.source else { return false }
        let script = RuntimeScript(source: source, runtimeVersion: remote.runtimeVersion, signature: remote.signature)
        guard script.digest == remote.digest,
              signature.verifies(remote.signature, runtimeVersion: remote.runtimeVersion, digest: script.digest)
        else { return false }
        served = script
        if let bundled {
            store.save(script, builtWith: bundled.digest)
        }
        return true
    }
}

/// Keeps the server's runtime in a directory of the app's caches (iOS may empty it; the app's
/// own runtime runs then until the server hands its own again), named by the digest of the
/// runtime the app was built with: its script, and its signature and version beside it.
struct ServedRuntimeStore {
    let directory: URL?

    static func caches() -> ServedRuntimeStore {
        ServedRuntimeStore(
            directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
                .appending(path: "PhoneRuntime", directoryHint: .isDirectory),
        )
    }

    /// The runtime kept for the build whose own runtime is `bundled`, if it is intact and the
    /// release key signed it; any other build's, and one that doesn't verify, is removed.
    func load(builtWith bundled: String, signature: RuntimeSignature) -> RuntimeScript? {
        guard let directory, let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path())
        else { return nil }
        let kept = [Self.scriptName(bundled), Self.signatureName(bundled)]
        for name in names where !kept.contains(name) {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
        guard let source = try? String(contentsOf: directory.appending(path: kept[0]), encoding: .utf8)
        else { return nil }
        let signed = (try? Data(contentsOf: directory.appending(path: kept[1])))
            .flatMap { try? JSONDecoder().decode(SignedRuntime.self, from: $0) }
        let script = RuntimeScript(
            source: source,
            runtimeVersion: signed?.runtimeVersion,
            signature: signed?.signature,
        )
        guard let signed,
              signature.verifies(signed.signature, runtimeVersion: signed.runtimeVersion, digest: script.digest)
        else {
            // Kept by a build that didn't check signatures, or changed since: never run.
            clear()
            return nil
        }
        return script
    }

    func save(_ script: RuntimeScript, builtWith bundled: String) {
        guard let directory, let runtimeVersion = script.runtimeVersion, let signature = script.signature,
              let signed = try? JSONEncoder().encode(SignedRuntime(
                  runtimeVersion: runtimeVersion,
                  signature: signature,
              ))
        else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data(script.source.utf8).write(to: directory.appending(path: Self.scriptName(bundled)), options: .atomic)
        try? signed.write(to: directory.appending(path: Self.signatureName(bundled)), options: .atomic)
    }

    func clear() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    private static func scriptName(_ bundled: String) -> String {
        "served-for-\(bundled).js"
    }

    private static func signatureName(_ bundled: String) -> String {
        "served-for-\(bundled).signature.json"
    }
}

/// The signature kept beside a served runtime.
private struct SignedRuntime: Codable {
    let runtimeVersion: Int
    let signature: String
}
