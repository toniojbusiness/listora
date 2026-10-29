import CryptoKit
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// Which phone runtime runs, and what the app tells the server it has: the server sends its
/// script only when it isn't the one the phone runs, so a launch never downloads the bundle the
/// app ships; and a runtime the server hands out runs only with the release key's signature.
struct RuntimeScriptsTests {
    private let bundled = "globalThis.listoraPhone = { version: 1 };"
    private let deployed = "globalThis.listoraPhone = { version: 2 };"
    /// A stand-in release key: the real one's private half is only in GitHub Actions.
    private let key = Curve25519.Signing.PrivateKey()

    @Test
    func `names the app's own runtime until the server hands out another`() {
        let scripts = scripts(store: Self.store())

        #expect(scripts.running?.source == bundled)
        // The server's digest: SHA-256 of the script's UTF-8 bytes, hex.
        #expect(scripts.running?.digest == RuntimeScript(source: bundled).digest)
        #expect(scripts.running?.digest.count == 64)
    }

    @Test
    func `a server that runs the app's own runtime changes nothing`() {
        var scripts = scripts(store: Self.store())

        let changed = scripts.take(remote(bundled, withSource: false, signed: false))
        #expect(!changed)
        #expect(scripts.running?.source == bundled)
    }

    @Test
    func `takes the server's signed runtime, and the next launch runs it without downloading it again`() {
        let store = Self.store()
        var scripts = scripts(store: store)

        let taken = scripts.take(remote(deployed))
        #expect(taken)
        #expect(scripts.running?.source == deployed)
        #expect(scripts.running?.runtimeVersion == 3)

        let relaunched = self.scripts(store: store)
        #expect(relaunched.running?.source == deployed)
    }

    @Test
    func `never runs a runtime the release key didn't sign`() {
        var scripts = scripts(store: Self.store())

        // Unsigned (a server without the key, or one someone else controls).
        #expect(!scripts.take(remote(deployed, signed: false)))
        // Signed by another key.
        let other = Curve25519.Signing.PrivateKey()
        #expect(!scripts.take(remote(deployed, signer: other)))
        // Signed for another version, or another runtime.
        #expect(!scripts.take(remote(deployed, signedVersion: 2)))
        let otherSignature = signature(RuntimeScript(source: "other").digest, version: 3)
        #expect(!scripts.take(RemoteRuntime(
            digest: RuntimeScript(source: deployed).digest, source: deployed, runtimeVersion: 3,
            signature: otherSignature,
        )))
        // A damaged signature.
        #expect(!scripts.take(RemoteRuntime(
            digest: RuntimeScript(source: deployed).digest, source: deployed, runtimeVersion: 3,
            signature: "not base64",
        )))
        #expect(scripts.running?.source == bundled)
    }

    @Test
    func `the release key the app pins is a valid Ed25519 public key`() {
        let key = Data(base64Encoded: RuntimeSignature.publicKey)
        #expect(key?.count == 32)
        #expect(key.flatMap { try? Curve25519.Signing.PublicKey(rawRepresentation: $0) } != nil)
        // It is no stand-in key of these tests.
        #expect(!RuntimeSignature.release.verifies(
            signature(RuntimeScript(source: deployed).digest, version: 3),
            runtimeVersion: 3,
            digest: RuntimeScript(source: deployed).digest,
        ))
    }

    @Test
    func `a kept runtime whose signature no longer verifies is dropped at launch`() throws {
        let store = Self.store()
        var scripts = scripts(store: store)
        #expect(scripts.take(remote(deployed)))

        // The kept script changed in the caches.
        let directory = try #require(store.directory)
        let name = try #require(try FileManager.default.contentsOfDirectory(atPath: directory.path())
            .first { $0.hasSuffix(".js") })
        try Data("globalThis.listoraPhone = { tampered: true };".utf8)
            .write(to: directory.appending(path: name))

        #expect(self.scripts(store: store).running?.source == bundled)
        // Gone, not left for the next launch.
        #expect(!FileManager.default.fileExists(atPath: directory.appending(path: name).path()))
    }

    @Test
    func `a runtime an older build kept without a signature is never run`() throws {
        let store = Self.store()
        let directory = try #require(store.directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let built = RuntimeScript(source: bundled).digest
        try Data(deployed.utf8).write(to: directory.appending(path: "served-for-\(built).js"))

        #expect(scripts(store: store).running?.source == bundled)
    }

    @Test
    func `a new app build runs its own runtime, never one an older build was handed`() {
        let store = Self.store()
        var scripts = scripts(store: store)
        _ = scripts.take(remote(deployed))

        let newBuild = "globalThis.listoraPhone = { version: 3 };"
        let updated = RuntimeScripts(bundled: newBuild, store: store, signature: verifier)
        #expect(updated.running?.source == newBuild)
        // The older build's copy is gone, not left in the caches.
        #expect(self.scripts(store: store).running?.source == bundled)
    }

    @Test
    func `a server back on the app's own runtime drops the one it handed out before`() {
        let store = Self.store()
        var scripts = scripts(store: store)
        _ = scripts.take(remote(deployed))

        // The app's own runtime came with the app: it needs no signature.
        let wentBack = scripts.take(remote(bundled, signed: false))
        #expect(wentBack)
        #expect(scripts.running?.source == bundled)
        #expect(self.scripts(store: store).running?.source == bundled)
    }

    @Test
    func `a script that isn't the one the server named is never run`() {
        var scripts = scripts(store: Self.store())
        let named = RuntimeScript(source: deployed).digest

        let tampered = scripts.take(RemoteRuntime(
            digest: named, source: "tampered", runtimeVersion: 3, signature: signature(named, version: 3),
        ))
        #expect(!tampered)
        let sourceless = scripts.take(RemoteRuntime(
            digest: named, source: nil, runtimeVersion: 3, signature: signature(named, version: 3),
        ))
        #expect(!sourceless)
        #expect(scripts.running?.source == bundled)
    }

    // MARK: - Helpers

    private var verifier: RuntimeSignature {
        RuntimeSignature(publicKey: key.publicKey.rawRepresentation.base64EncodedString())
    }

    private func scripts(store: ServedRuntimeStore) -> RuntimeScripts {
        RuntimeScripts(bundled: bundled, store: store, signature: verifier)
    }

    /// The server's answer for `script`, signed by the test's release key unless told otherwise.
    private func remote(
        _ script: String,
        withSource: Bool = true,
        signed: Bool = true,
        signer: Curve25519.Signing.PrivateKey? = nil,
        signedVersion: Int = 3,
    ) -> RemoteRuntime {
        let digest = RuntimeScript(source: script).digest
        let signature = signed ? signature(digest, version: signedVersion, signer: signer ?? key) : nil
        return RemoteRuntime(
            digest: digest,
            source: withSource ? script : nil,
            runtimeVersion: 3,
            signature: signature,
        )
    }

    private func signature(_ digest: String, version: Int, signer: Curve25519.Signing.PrivateKey? = nil) -> String {
        let message = RuntimeSignature.message(runtimeVersion: version, digest: digest)
        // swiftlint:disable:next force_try
        return try! (signer ?? key).signature(for: message).base64EncodedString()
    }

    private static func store() -> ServedRuntimeStore {
        ServedRuntimeStore(
            directory: FileManager.default.temporaryDirectory
                .appending(path: UUID().uuidString, directoryHint: .isDirectory),
        )
    }
}
