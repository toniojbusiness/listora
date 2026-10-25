import Foundation

/// The batch endpoints of the fake, true to the contract where the upload queue depends on it: an
/// item per position (adding at a taken position answers with the item there), and a submit that
/// needs every photo attached.
extension FakeListoraServer {
    /// A batch: its items by position, what was submitted, and the interaction last sent.
    struct Batch: Equatable {
        var id: String
        var positions: [Int: String] = [:]
        /// Photo count of each item's latest submit.
        var submitted: [String: Int] = [:]
        var submits = 0
        var interactionTaps: Int?
        var interactionItemIDs: [String] = []
    }

    static func batchRoute(_ request: StubRequest, parts: [String], in state: inout State) -> StubReply {
        switch (request.method, parts.count) {
        case ("POST", 2):
            let batch = Batch(id: UUID().uuidString.lowercased())
            state.batches[batch.id] = batch
            return .json(201, batchJSON(batch, state: state))
        case ("GET", 3):
            return state.batches[parts[2]].map { .json(200, batchJSON($0, state: state)) } ?? notFound
        case ("POST", 4) where parts[3] == "items":
            return addItem(request, batchID: parts[2], in: &state)
        case ("POST", 6) where parts[3] == "items" && parts[5] == "submit":
            return submit(request, batchID: parts[2], itemID: parts[4], in: &state)
        case ("PUT", 4) where parts[3] == "interaction":
            return replaceInteraction(request, batchID: parts[2], in: &state)
        default:
            return notFound
        }
    }

    private static func addItem(_ request: StubRequest, batchID: String, in state: inout State) -> StubReply {
        guard var batch = state.batches[batchID] else { return notFound }
        guard let position = json(request.body)?["position"] as? Int else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        if let existing = batch.positions[position], let item = state.items[existing] {
            return .json(200, batchItemJSON(item, position: position, batch: batch))
        }
        let item = newItem(in: &state)
        batch.positions[position] = item.id
        state.batches[batch.id] = batch
        return .json(201, batchItemJSON(item, position: position, batch: batch))
    }

    private static func submit(
        _ request: StubRequest,
        batchID: String,
        itemID: String,
        in state: inout State,
    ) -> StubReply {
        guard var batch = state.batches[batchID], let item = state.items[itemID],
              let position = batch.positions.first(where: { $0.value == item.id })?.key
        else { return notFound }
        guard let count = json(request.body)?["photoCount"] as? Int else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        guard count == item.photos.count else {
            return .error(409, code: "invalid_state_transition", message: "Attach the rest.", retryable: false)
        }
        batch.submitted[item.id] = count
        batch.submits += 1
        state.batches[batch.id] = batch
        return .json(202, batchItemJSON(item, position: position, batch: batch))
    }

    private static func replaceInteraction(
        _ request: StubRequest,
        batchID: String,
        in state: inout State,
    ) -> StubReply {
        guard var batch = state.batches[batchID], let body = json(request.body) else { return notFound }
        batch.interactionTaps = (body["batch"] as? [String: Any])?["taps"] as? Int
        batch.interactionItemIDs = (body["items"] as? [[String: Any]] ?? []).compactMap { $0["itemId"] as? String }
        state.batches[batch.id] = batch
        return .json(200, batchJSON(batch, state: state))
    }

    private static func batchJSON(_ batch: Batch, state: State) -> [String: Any] {
        let items = batch.positions.sorted { $0.key < $1.key }.compactMap { position, id in
            state.items[id].map { batchItemJSON($0, position: position, batch: batch) }
        }
        return [
            "id": batch.id,
            "items": items,
            "progress": [
                "total": items.count, "uploading": items.count, "preparingPhotos": 0, "analyzing": 0,
                "readyForReview": 0, "saved": 0, "failed": 0,
            ],
            "createdAt": timestamp,
            "updatedAt": timestamp,
        ]
    }

    private static func batchItemJSON(_ item: Item, position: Int, batch: Batch) -> [String: Any] {
        let submitted = batch.submitted[item.id] != nil
        return [
            "position": position,
            "item": [
                "id": item.id, "sku": item.sku, "status": "draft", "listings": [Any](),
                "createdAt": timestamp, "updatedAt": timestamp,
            ],
            "state": submitted ? "analyzing" : "uploading",
            "statusDisplay": ["tone": "in_progress", "label": submitted ? "Analyzing..." : "Uploading photos..."],
            "photos": ["total": item.photos.count, "ready": 0],
        ]
    }
}
