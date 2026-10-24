import APIClient
import Foundation

/// Byte transfers: started by the loop, finished by the transport's events.
extension PhotoUploader {
    func startTransfer(of photo: DraftPhotoRecord?) async {
        guard let photo, let target = photo.target else { return }
        var request = URLRequest(url: target.url)
        request.httpMethod = "PUT"
        for header in target.headers {
            request.setValue(header.value, forHTTPHeaderField: header.name)
        }
        transferring.insert(photo.id)
        await publish()
        transport.start(request, fromFile: store.fileURL(for: photo), photoID: photo.id)
    }

    func handle(_ event: TransferEvent) async {
        // The result is recorded before the photo leaves `transferring`, with no suspension in
        // between, so the loop never sees it as neither in flight nor finished and sends it twice.
        record(event)
        transferring.remove(event.photoID)
        wake()
        await publish()
    }

    private func record(_ event: TransferEvent) {
        let failure: APIFailure
        switch event.result {
        case .cancelled:
            return
        case let .response(statusCode) where (200 ..< 300).contains(statusCode):
            _ = try? store.updatePhoto(event.photoID) { photo in
                guard photo.step == .transfer else { return }
                photo.step = .attach
                photo.target = nil
                photo.retry.retryAt = nil
            }
            return
        case let .response(statusCode):
            failure = Self.transferFailure(statusCode: statusCode)
        case .failed:
            failure = .networkUnavailable
        }
        let refreshTarget = failure.statusCode == 403
        recordPhotoFailure(event.photoID, failure) { photo in
            if refreshTarget {
                photo.target = nil
            }
        }
    }

    /// The storage server's answer to a byte transfer. `403` is an expired or rejected link, fixed
    /// by asking the API for a fresh one; other client errors cannot pass by retrying.
    static func transferFailure(statusCode: Int) -> APIFailure {
        let retryable = statusCode >= 500 || [403, 408, 429].contains(statusCode)
        let message = retryable
            ? "The photo upload was interrupted."
            : "The storage server refused this photo (HTTP \(statusCode))."
        return APIFailure(statusCode: statusCode, code: "upload_failed", message: message, retryable: retryable)
    }
}
