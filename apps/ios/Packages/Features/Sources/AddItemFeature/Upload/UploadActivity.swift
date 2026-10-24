import Observation

/// What the upload queue is doing right now, beyond what the database records: whether someone is
/// signed in and which photos' bytes are in flight. Views read it together with the drafts.
@MainActor
@Observable
final class UploadActivity {
    private(set) var isSignedIn = false
    private(set) var transferring: Set<String> = []

    func update(isSignedIn: Bool, transferring: Set<String>) {
        if self.isSignedIn != isSignedIn {
            self.isSignedIn = isSignedIn
        }
        if self.transferring != transferring {
            self.transferring = transferring
        }
    }
}
