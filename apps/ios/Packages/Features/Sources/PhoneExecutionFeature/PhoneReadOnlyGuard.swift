import Core
import Foundation

/// The phone's own read-only refusal (docs/features/read-only.md#on-the-phone), in the app
/// before any of the runtime's script runs, so it holds whatever runtime or call the server
/// hands out: a write script for an account this phone holds read only is answered as refused,
/// and nothing loads.
///
/// The phone holds an account read only once it learned so: a call that says `readOnly`, the
/// seller's Read only switch, or Link accounts showing it. Only the seller turning Read only off
/// on this phone lets it go (`MarketplaceSessionStore.setReadOnly`), so a server that stops
/// saying it never makes the account writable here.
enum PhoneReadOnlyGuard {
    /// The scripts that only read. Every other script is a write, as on the server
    /// (`isWriteCall` in `@listora/automation`), so a script added later is refused here until it
    /// is listed as a read.
    static let readScripts: Set = ["read", "health", "orders", "listings", "labels", "offers", "offer"]

    /// The runtime's answer refusing `call` (`PhoneCallInput`), or nil when it may run.
    static func refusal(
        of call: [String: Any],
        marketplace: String,
        sessions: any MarketplaceSessionStore,
    ) -> [String: Any]? {
        var marketplaces = [marketplace]
        if let named = (call["scriptSet"] as? [String: Any])?["marketplace"] as? String, named != marketplace {
            marketplaces.append(named)
        }
        if call["readOnly"] as? Bool == true {
            for name in marketplaces {
                sessions.setReadOnly(true, for: name)
            }
        }
        guard marketplaces.contains(where: { sessions.isReadOnly($0) }) else { return nil }
        if let script = (call["call"] as? [String: Any])?["script"] as? String, readScripts.contains(script) {
            return nil
        }
        return refused
    }

    /// As the runtime's own refusal says it (`readOnlyRefusal` in `phone/runtime.ts`): no step
    /// ran, so nothing changed, and the server records it as refused, never retried.
    static var refused: [String: Any] {
        [
            "type": "ran",
            "result": [
                "ok": false,
                "mutated": false,
                "steps": [Any](),
                "failure": [
                    "kind": "error",
                    "step": "phone",
                    "code": "read_only",
                    "message": "the account is read only on this iPhone, so it ran no write script",
                    "retryAfterMs": NSNull(),
                    "screenshotKey": NSNull(),
                ] as [String: Any],
            ] as [String: Any],
        ]
    }
}
