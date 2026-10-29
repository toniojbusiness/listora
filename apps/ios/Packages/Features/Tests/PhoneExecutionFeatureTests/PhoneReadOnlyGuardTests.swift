import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The phone's own read-only refusal (docs/features/read-only.md#on-the-phone): a write on an
/// account this phone holds read only is refused before any of the runtime's script runs,
/// whatever the call says.
struct PhoneReadOnlyGuardTests {
    /// `extra`: what else the call says (`readOnly`).
    private func call(_ script: String, marketplace: String = "depop", _ extra: [String: Any] = [:]) -> [String: Any] {
        let base: [String: Any] = [
            "runtimeVersion": 3,
            "scriptSet": ["name": marketplace, "marketplace": marketplace, "siteUrl": "https://www.depop.com"],
            "call": ["script": script, "op": [String: Any]()],
            "origins": ["https://www.depop.com"],
            "cookieDomains": ["depop.com"],
        ]
        return base.merging(extra) { _, new in new }
    }

    private func refused(
        _ call: [String: Any],
        in marketplace: String = "depop",
        _ sessions: InMemoryMarketplaceSessionStore,
    ) -> Bool {
        PhoneReadOnlyGuard.refusal(of: call, marketplace: marketplace, sessions: sessions) != nil
    }

    private static let writes = ["create", "revise", "price", "end", "relist", "markSold", "refresh", "answerOffer"]

    @Test
    func `refuses every write on an account this phone holds read only, though the call doesn't say so`() throws {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")

        for script in Self.writes {
            let answer = try #require(
                PhoneReadOnlyGuard.refusal(of: call(script), marketplace: "depop", sessions: sessions),
                "\(script) was not refused",
            )
            let result = try #require(answer["result"] as? [String: Any])
            let failure = try #require(result["failure"] as? [String: Any])
            #expect(result["ok"] as? Bool == false)
            #expect(result["mutated"] as? Bool == false)
            #expect(failure["code"] as? String == "read_only")
            #expect(JSONSerialization.isValidJSONObject(answer))
        }
    }

    @Test
    func `a script it does not know as a read is a write`() {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")

        #expect(refused(call("share"), sessions))
        var nameless = call("read")
        nameless["call"] = [String: Any]()
        #expect(refused(nameless, sessions))
    }

    @Test
    func `runs the reads on a read-only account`() {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")

        for script in PhoneReadOnlyGuard.readScripts {
            #expect(!refused(call(script), sessions), "\(script) was refused")
        }
    }

    @Test
    func `a call that says read only holds the account read only from then on`() {
        let sessions = InMemoryMarketplaceSessionStore()

        #expect(refused(call("create", ["readOnly": true]), sessions))
        #expect(sessions.isReadOnly("depop"))
        // A later call that no longer says it, or says otherwise, is still refused.
        #expect(refused(call("end"), sessions))
        #expect(refused(call("end", ["readOnly": false]), sessions))
    }

    @Test
    func `a call naming a read-only marketplace's scripts in another lane is refused too`() {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")

        #expect(refused(call("create"), in: "poshmark", sessions))
    }

    @Test
    func `lets writes run on the other accounts`() {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")

        #expect(!refused(call("create", marketplace: "poshmark"), in: "poshmark", sessions))
    }
}
