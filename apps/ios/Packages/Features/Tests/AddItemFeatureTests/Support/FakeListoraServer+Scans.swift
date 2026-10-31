import Foundation

/// The thrift scan's `keepScan` in the fake (docs/features/thrift-scan.md): one item per scan,
/// whatever the key, and none for a scan that can no longer be kept.
extension FakeListoraServer {
    /// A scan whose run ended without it: keeping it is refused.
    func closeScan(_ scanID: String) {
        state.withLock { _ = $0.closedScans.insert(scanID) }
    }

    /// The item a kept scan became.
    func item(ofScan scanID: String) -> String? {
        state.withLock { $0.scanItems[scanID] }
    }

    /// `keepScan`: one item per scan, whatever the key (docs/features/thrift-scan.md).
    static func keepScan(_ scanID: String, in state: inout State) -> StubReply {
        if let itemID = state.scanItems[scanID] {
            return state.items[itemID].map { .json(200, itemJSON($0)) } ?? .error(
                409,
                code: "invalid_state_transition",
                message: "The item this scan was kept as was deleted.",
                retryable: false,
            )
        }
        guard !state.closedScans.contains(scanID) else {
            return .error(409, code: "invalid_state_transition", message: "This run ended.", retryable: false)
        }
        let item = newItem(in: &state)
        state.scanItems[scanID] = item.id
        return .json(201, itemJSON(item))
    }
}
