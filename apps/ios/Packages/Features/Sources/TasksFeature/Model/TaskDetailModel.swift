import APIClient
import Foundation
import Observation

/// One task: what to copy, the photos to save in order, the link that opens the marketplace, and
/// the user's confirmation. Done sends the confirmation to the server, which alone finishes the
/// task; the app shows "Done (you confirmed)" only once the server says so.
@MainActor
@Observable
final class TaskDetailModel {
    enum PhotoState: Equatable {
        case idle
        case saving(saved: Int, total: Int)
        case saved(count: Int)
        case failed(message: String)
    }

    /// What the task screen ends with.
    enum Outcome: Equatable {
        case completed
        case dismissed
    }

    private(set) var task: UserTask
    let presentation: TaskPresentation
    private(set) var photoState: PhotoState = .idle
    /// The new listing's link, pasted or typed, for a list task.
    var listingURL = ""
    /// Why Done or Dismiss did not go through, safe to show.
    private(set) var problem: String?
    private(set) var isSubmitting = false
    /// Set once the server has finished the task.
    private(set) var outcome: Outcome?

    private let service: any TasksService
    private let pasteboard: any Pasteboard
    private let photoSaver: any PhotoSaving
    /// One Idempotency-Key per action, reused when its answer was lost, so a second tap never
    /// confirms twice.
    private var completeKey = UUID().uuidString
    private var dismissKey = UUID().uuidString

    init(task: UserTask, service: any TasksService, pasteboard: any Pasteboard, photoSaver: any PhotoSaving) {
        self.task = task
        presentation = TaskPresentation(task)
        self.service = service
        self.pasteboard = pasteboard
        self.photoSaver = photoSaver
    }

    var fields: [CopyField] {
        task.copyAssist?.fields.map { CopyField(label: $0.label, value: $0.value) } ?? []
    }

    /// The photos in posting order, cover first.
    var photos: [Photo] {
        task.copyAssist?.photos ?? []
    }

    var deepLink: URL? {
        task.deepLink.flatMap(URL.init(string:))
    }

    /// Copies one field and returns the confirmation to show.
    func copy(_ field: CopyField) -> String {
        pasteboard.copy(field.value)
        return "\(field.label) copied"
    }

    /// Saves the task's photos to the camera roll in posting order.
    func savePhotos() async {
        if case .saving = photoState {
            return
        }
        let urls = photos.compactMap { photo in (photo.urls?.listing).flatMap(URL.init(string:)) }
        guard !urls.isEmpty else {
            photoState = .failed(message: "These photos aren't ready yet. Try again in a moment.")
            return
        }
        photoState = .saving(saved: 0, total: urls.count)
        do {
            try await photoSaver.save(urls) { [weak self] saved in
                self?.photoState = .saving(saved: saved, total: urls.count)
            }
            photoState = .saved(count: urls.count)
        } catch {
            photoState = .failed(message: Self.message(for: error))
        }
    }

    /// What the link field already knows is wrong; the server checks the link again.
    var linkProblem: String? {
        let trimmed = listingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let url = URL(string: trimmed), url.scheme == "https" || url.scheme == "http", url.host != nil else {
            return "Paste the listing's link. It starts with https://"
        }
        return nil
    }

    /// Sends the user's confirmation. For a list task, a pasted link links the new listing.
    func complete() async {
        guard !isSubmitting, presentation.doneTitle != nil, linkProblem == nil else { return }
        let typed = listingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = presentation.takesListingLink && !typed.isEmpty ? typed : nil
        await submit(\.completeKey, ending: .completed) { [service, task] key throws(APIFailure) in
            try await service.complete(taskID: task.id, listingURL: link, idempotencyKey: key)
        }
    }

    /// Gives the task up: its listing shows the step as failed, with a Retry that makes a new task.
    func dismiss() async {
        guard !isSubmitting else { return }
        await submit(\.dismissKey, ending: .dismissed) { [service, task] key throws(APIFailure) in
            try await service.dismiss(taskID: task.id, idempotencyKey: key)
        }
    }

    // MARK: Private

    /// Sends one action with the key at `key`, and ends the screen with `outcome` once the server
    /// answers.
    private func submit(
        _ key: ReferenceWritableKeyPath<TaskDetailModel, String>,
        ending outcome: Outcome,
        _ send: (String) async throws(APIFailure) -> UserTask,
    ) async {
        isSubmitting = true
        problem = nil
        defer { isSubmitting = false }
        do {
            task = try await send(self[keyPath: key])
            self.outcome = outcome
        } catch {
            // A refusal is final for this key; an answer that never arrived is sent again as is.
            if error.statusCode != nil {
                self[keyPath: key] = UUID().uuidString
            }
            problem = error.message
        }
    }

    private static func message(for error: PhotoSaveError) -> String {
        switch error {
        case .notAllowed:
            "Listora can't add photos. Allow it in Settings > Listora > Photos, then try again."
        case .download:
            "The photos didn't download. Check your connection and try again."
        case .save:
            "Your photo library didn't take the photos. Try again."
        }
    }
}

/// A value the user copies with one tap.
struct CopyField: Equatable, Identifiable, Sendable {
    let label: String
    let value: String

    var id: String {
        label
    }
}
