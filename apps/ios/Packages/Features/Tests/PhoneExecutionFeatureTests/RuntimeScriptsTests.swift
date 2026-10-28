import Foundation
import Testing
@testable import PhoneExecutionFeature

/// Which phone runtime runs, and what the app tells the server it has: the server sends its
/// script only when it isn't the one the phone runs, so a launch never downloads the bundle the
/// app ships.
struct RuntimeScriptsTests {
    private let bundled = "globalThis.listoraPhone = { version: 1 };"
    private let deployed = "globalThis.listoraPhone = { version: 2 };"

    @Test
    func `names the app's own runtime until the server hands out another`() {
        let scripts = RuntimeScripts(bundled: bundled, store: Self.store())

        #expect(scripts.running?.source == bundled)
        // The server's digest: SHA-256 of the script's UTF-8 bytes, hex.
        #expect(scripts.running?.digest == RuntimeScript(source: bundled).digest)
        #expect(scripts.running?.digest.count == 64)
    }

    @Test
    func `a server that runs the app's own runtime changes nothing`() {
        var scripts = RuntimeScripts(bundled: bundled, store: Self.store())

        let changed = scripts.take(RemoteRuntime(digest: RuntimeScript(source: bundled).digest, source: nil))
        #expect(!changed)
        #expect(scripts.running?.source == bundled)
    }

    @Test
    func `takes the server's runtime, and the next launch runs it without downloading it again`() {
        let store = Self.store()
        var scripts = RuntimeScripts(bundled: bundled, store: store)
        let remote = RuntimeScript(source: deployed)

        let taken = scripts.take(RemoteRuntime(digest: remote.digest, source: deployed))
        #expect(taken)
        #expect(scripts.running == remote)

        let relaunched = RuntimeScripts(bundled: bundled, store: store)
        #expect(relaunched.running == remote)
    }

    @Test
    func `a new app build runs its own runtime, never one an older build was handed`() {
        let store = Self.store()
        var scripts = RuntimeScripts(bundled: bundled, store: store)
        _ = scripts.take(RemoteRuntime(digest: RuntimeScript(source: deployed).digest, source: deployed))

        let newBuild = "globalThis.listoraPhone = { version: 3 };"
        let updated = RuntimeScripts(bundled: newBuild, store: store)
        #expect(updated.running?.source == newBuild)
        // The older build's copy is gone, not left in the caches.
        #expect(RuntimeScripts(bundled: bundled, store: store).running?.source == bundled)
    }

    @Test
    func `a server back on the app's own runtime drops the one it handed out before`() {
        let store = Self.store()
        var scripts = RuntimeScripts(bundled: bundled, store: store)
        _ = scripts.take(RemoteRuntime(digest: RuntimeScript(source: deployed).digest, source: deployed))

        let wentBack = scripts.take(RemoteRuntime(digest: RuntimeScript(source: bundled).digest, source: bundled))
        #expect(wentBack)
        #expect(scripts.running?.source == bundled)
        #expect(RuntimeScripts(bundled: bundled, store: store).running?.source == bundled)
    }

    @Test
    func `a script that isn't the one the server named is never run`() {
        var scripts = RuntimeScripts(bundled: bundled, store: Self.store())

        let tampered = scripts.take(RemoteRuntime(digest: RuntimeScript(source: deployed).digest, source: "tampered"))
        #expect(!tampered)
        let sourceless = scripts.take(RemoteRuntime(digest: RuntimeScript(source: deployed).digest, source: nil))
        #expect(!sourceless)
        #expect(scripts.running?.source == bundled)
    }

    private static func store() -> ServedRuntimeStore {
        ServedRuntimeStore(
            directory: FileManager.default.temporaryDirectory
                .appending(path: UUID().uuidString, directoryHint: .isDirectory),
        )
    }
}
