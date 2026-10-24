import Foundation

/// What a photo's upload looks like to the user. Derived from its record and the queue's
/// activity; "Uploaded" means the server has attached the photo to the item, nothing less.
enum PhotoUploadStatus: Equatable, Sendable {
    case waiting
    case readingTag
    case uploading
    case uploaded
    /// A request failed and is retried at its `retryAt` (`attempt` of `maxAttempts`).
    case retrying(attempt: Int, maxAttempts: Int)
    case waitingForSignIn
    case failed(message: String)

    init(photo: DraftPhotoRecord, isTransferring: Bool, isSignedIn: Bool, policy: RetryPolicy = .standard) {
        if let failure = photo.retry.failure {
            self = .failed(message: failure)
        } else if photo.step == .done, photo.serverRole == photo.role {
            self = .uploaded
        } else if isTransferring {
            self = .uploading
        } else if photo.role == .tag, photo.tagReadState == .pending {
            self = .readingTag
        } else if !isSignedIn {
            self = .waitingForSignIn
        } else if photo.retry.retryAt != nil, photo.retry.attempt > 0 {
            self = .retrying(attempt: photo.retry.attempt, maxAttempts: policy.maxAttempts)
        } else {
            self = .waiting
        }
    }

    var label: String {
        switch self {
        case .waiting: "Waiting to upload"
        case .readingTag: "Reading tag"
        case .uploading: "Uploading"
        case .uploaded: "Uploaded"
        case let .retrying(attempt, maxAttempts): "Retrying (\(attempt) of \(maxAttempts))"
        case .waitingForSignIn: "Sign in to upload"
        case .failed: "Upload failed"
        }
    }

    var systemImage: String {
        switch self {
        case .waiting: "clock"
        case .readingTag: "text.viewfinder"
        case .uploading: "arrow.up.circle"
        case .uploaded: "checkmark.circle.fill"
        case .retrying: "arrow.clockwise.circle"
        case .waitingForSignIn: "person.crop.circle.badge.exclamationmark"
        case .failed: "exclamationmark.triangle.fill"
        }
    }
}

/// One line about a whole draft's upload, for the draft list and the editor's banner.
struct DraftUploadSummary: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case neutral
        /// Nothing to upload yet.
        case empty
        case success
        case warning
        case danger
    }

    let text: String
    let tone: Tone
    /// True when retries stopped and the user can start them again.
    let canRetry: Bool

    init(draft: Draft, transferring: Set<String>, isSignedIn: Bool) {
        let statuses = draft.photos.map {
            PhotoUploadStatus(photo: $0, isTransferring: transferring.contains($0.id), isSignedIn: isSignedIn)
        }
        let total = statuses.count
        let uploaded = statuses.count(where: { $0 == .uploaded })
        let failed = statuses.count(where: {
            if case .failed = $0 {
                true
            } else {
                false
            }
        })
        if let failure = draft.record.retry.failure {
            self.init(text: "Couldn't save the draft to Listora: \(failure)", tone: .danger, canRetry: true)
        } else if total == 0 {
            self.init(text: "No photos yet. Add photos to continue.", tone: .empty, canRetry: false)
        } else if failed > 0 {
            let photos = failed == 1 ? "1 photo" : "\(failed) photos"
            self.init(text: "\(photos) failed to upload", tone: .danger, canRetry: true)
        } else if total > 0, uploaded == total,
                  draft.record.syncedPhotoOrder == draft.photos.compactMap(\.serverPhotoID)
        {
            let photos = total == 1 ? "1 photo" : "all \(total) photos"
            self.init(text: "Saved to Listora with \(photos)", tone: .success, canRetry: false)
        } else if !isSignedIn {
            self.init(text: "Saved on this phone. Sign in to upload.", tone: .warning, canRetry: false)
        } else {
            self.init(text: "Uploading photos (\(uploaded) of \(total) done)", tone: .neutral, canRetry: false)
        }
    }

    private init(text: String, tone: Tone, canRetry: Bool) {
        self.text = text
        self.tone = tone
        self.canRetry = canRetry
    }
}
