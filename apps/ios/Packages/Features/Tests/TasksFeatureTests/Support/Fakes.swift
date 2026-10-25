import APIClient
import Foundation
import ListoraAPI
@testable import TasksFeature

/// Tasks as the server sends them: decoded from the contract's JSON, like the app decodes them.
enum Fixtures {
    static let itemID = "0199f0b4-0000-7000-8000-0000000000b1"
    static let created = Date(timeIntervalSince1970: 1_800_000_000)

    static func task(
        id: String = "0199f0b4-0000-7000-8000-0000000000f1",
        kind: String = "list_manually",
        urgency: String = "normal",
        title: String = "List on Poshmark",
        marketplace: String? = "poshmark",
        deepLink: String? = "https://poshmark.com/",
        operationID: String? = "0199f0b4-0000-7000-8000-0000000000d1",
        fields: [(String, String)] = [
            ("Title", "Everlane Linen Shirt"),
            ("Description", "Worn twice."),
            ("Price", "28.00"),
        ],
        photos: [String] = ["front", "back", "tag"],
        createdAt: Date = created,
    ) -> UserTask {
        var object: [String: Any] = [
            "id": id,
            "kind": kind,
            "status": "open",
            "urgency": urgency,
            "title": title,
            "instructions": "Save the photos, copy the details, and post the listing.",
            "itemId": itemID,
            "item": ["id": itemID, "sku": "AJ-000184", "title": "Linen Button-Up Shirt"],
            "createdAt": createdAt.ISO8601Format(),
        ]
        if let marketplace {
            object["marketplace"] = marketplace
        }
        if let deepLink {
            object["deepLink"] = deepLink
        }
        if let operationID {
            object["operationId"] = operationID
        }
        if !fields.isEmpty || !photos.isEmpty {
            object["copyAssist"] = [
                "fields": fields.map { ["label": $0.0, "value": $0.1] },
                "photos": photos.enumerated().map { index, role in photo(position: index, role: role) },
            ]
        }
        let data = try! JSONSerialization.data(withJSONObject: object) // swiftlint:disable:this force_try
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try! decoder.decode(UserTask.self, from: data) // swiftlint:disable:this force_try
    }

    static func photo(position: Int, role: String) -> [String: Any] {
        [
            "id": "0199f0b4-0000-7000-8000-00000000010\(position)",
            "itemId": itemID,
            "position": position,
            "role": role,
            "status": "ready",
            "width": 1600,
            "height": 1200,
            "sha256": String(repeating: "a", count: 64),
            "ocrLines": [],
            "barcodes": [],
            "urls": [
                "thumbnail": "https://media.listora.test/\(role)-thumb.jpg",
                "listing": "https://media.listora.test/\(role).jpg",
            ],
            "createdAt": created.ISO8601Format(),
        ]
    }
}

/// A ``TasksService`` that answers from a script and records every call.
actor FakeTasksService: TasksService {
    var open: [UserTask] = []
    var openResult: Result<Void, APIFailure> = .success(())
    /// Answers for `complete` and `dismiss`, in order; an empty script succeeds.
    var answers: [Result<Void, APIFailure>] = []
    struct Completion: Equatable {
        let taskID: String
        let listingURL: String?
        let key: String
    }

    private(set) var completions: [Completion] = []
    private(set) var dismissals: [(taskID: String, key: String)] = []

    func setOpen(_ tasks: [UserTask]) {
        open = tasks
    }

    func failOpen(with failure: APIFailure?) {
        openResult = failure.map { .failure($0) } ?? .success(())
    }

    func script(_ results: [Result<Void, APIFailure>]) {
        answers = results
    }

    func openTasks(itemID: String?) async throws(APIFailure) -> [UserTask] {
        if case let .failure(failure) = openResult {
            throw failure
        }
        return open.filter { itemID == nil || $0.itemId == itemID }
    }

    func task(id: String) async throws(APIFailure) -> UserTask {
        guard let task = open.first(where: { $0.id == id }) else {
            throw APIFailure(statusCode: 404, code: "not_found", message: "Task was not found.", retryable: false)
        }
        return task
    }

    func complete(taskID: String, listingURL: String?, idempotencyKey: String) async throws(APIFailure) -> UserTask {
        completions.append(Completion(taskID: taskID, listingURL: listingURL, key: idempotencyKey))
        try next()
        return try await settled(taskID, status: "completed")
    }

    func dismiss(taskID: String, idempotencyKey: String) async throws(APIFailure) -> UserTask {
        dismissals.append((taskID, idempotencyKey))
        try next()
        return try await settled(taskID, status: "dismissed")
    }

    private func next() throws(APIFailure) {
        guard !answers.isEmpty else { return }
        if case let .failure(failure) = answers.removeFirst() {
            throw failure
        }
    }

    private func settled(_ taskID: String, status: String) async throws(APIFailure) -> UserTask {
        let task = try await task(id: taskID)
        open.removeAll { $0.id == taskID }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        // swiftlint:disable force_try
        var object = (try! JSONSerialization.jsonObject(with: encoder.encode(task)) as? [String: Any]) ?? [:]
        object["status"] = status
        object["completedAt"] = Fixtures.created.addingTimeInterval(60).ISO8601Format()
        return try! decoder.decode(UserTask.self, from: JSONSerialization.data(withJSONObject: object))
        // swiftlint:enable force_try
    }
}

/// Records the reminders the inbox asks for.
actor RecordingReminders: TaskReminding {
    private(set) var synced: [[TaskReminder]] = []

    func sync(_ reminders: [TaskReminder]) async {
        synced.append(reminders)
    }
}

@MainActor
final class RecordingPasteboard: Pasteboard {
    private(set) var copied: [String] = []

    func copy(_ value: String) {
        copied.append(value)
    }
}

/// Records the photos saved, in order, or fails.
actor RecordingPhotoSaver: PhotoSaving {
    private(set) var saved: [URL] = []
    var failure: PhotoSaveError?

    func fail(with failure: PhotoSaveError?) {
        self.failure = failure
    }

    func save(_ urls: [URL], progress: @escaping @MainActor @Sendable (Int) -> Void) async throws(PhotoSaveError) {
        if let failure {
            throw failure
        }
        for (index, url) in urls.enumerated() {
            saved.append(url)
            await progress(index + 1)
        }
    }
}

extension APIFailure {
    static let refused = APIFailure(
        statusCode: 422,
        code: "validation_failed",
        message: "This is a Mercari link. Paste the Poshmark listing's link.",
        retryable: false,
    )
}
