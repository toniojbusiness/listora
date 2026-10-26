import APIClient
import DesignSystem
import Foundation
import Observation
import UIKit

/// The seller's profile: who is signed in (the email, read-only), the name they go by and the
/// business they sell as (both saved on the server), and their photo (on this iPhone only). The
/// avatar in the Today and Sales headers and the top of Settings show it.
@MainActor
@Observable
public final class ProfileModel {
    public enum Phase: Equatable {
        /// Nothing read yet.
        case loading
        case loaded
        /// The profile could not be read; `message` is safe to show.
        case failed(message: String)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var profile: Profile?
    public private(set) var photo: UIImage?
    /// Why the last photo could not be used or kept, safe to show.
    public private(set) var photoProblem: String?

    /// The edit screen's fields, filled by ``beginEditing()``.
    public var draftName = ""
    public var draftBusinessName = ""
    public private(set) var isSaving = false
    /// Why the last save failed, safe to show; nothing was saved then.
    public private(set) var saveError: String?

    private let service: any ProfileService
    private let photos: any AvatarStore
    private let signedInEmail: @MainActor () -> String?

    /// `signedInEmail`: the session's email, which names the photo on this iPhone and shows until
    /// the server's profile arrives.
    public init(
        service: any ProfileService,
        photos: any AvatarStore,
        signedInEmail: @escaping @MainActor () -> String?,
    ) {
        self.service = service
        self.photos = photos
        self.signedInEmail = signedInEmail
    }

    /// The signed-in email, the server's once it answered.
    public var email: String? {
        profile?.email ?? signedInEmail()
    }

    /// The avatar's letters: from the name, else the business, else the email.
    public var initials: String {
        Avatar.initials(for: [profile?.displayName, profile?.businessName, email])
    }

    /// The profile's heading: the name, else the business, else a prompt to add one.
    public var title: String {
        profile?.displayName ?? profile?.businessName ?? "Add your name"
    }

    /// Reads the profile (and this iPhone's photo for the person signed in).
    public func load() async {
        guard let sessionEmail = signedInEmail() else {
            signedOut()
            return
        }
        photo = photos.photo(for: sessionEmail).flatMap(UIImage.init(data:))
        if profile == nil {
            phase = .loading
        }
        do {
            profile = try await service.profile()
            phase = .loaded
        } catch {
            // A profile already shown stays; the next load tries again.
            if profile == nil {
                phase = .failed(message: error.message)
            }
        }
    }

    /// Fills the edit screen's fields from the profile.
    public func beginEditing() {
        draftName = profile?.displayName ?? ""
        draftBusinessName = profile?.businessName ?? ""
        saveError = nil
    }

    /// True when the fields differ from what the server has.
    public var hasChanges: Bool {
        Self.trimmed(draftName) != profile?.displayName || Self.trimmed(draftBusinessName) != profile?.businessName
    }

    /// Saves both names, trimmed (an empty field clears its name); true once the server has them.
    public func save() async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            profile = try await service.save(
                displayName: Self.trimmed(draftName),
                businessName: Self.trimmed(draftBusinessName),
            )
            phase = .loaded
            return true
        } catch {
            saveError = error.message
            return false
        }
    }

    /// Makes a picked photo the profile photo, kept on this iPhone.
    public func setPhoto(_ data: Data) async {
        guard let email = signedInEmail() else { return }
        let prepared = await Task.detached(priority: .userInitiated) { AvatarPhoto.prepared(data) }.value
        guard let prepared, let image = UIImage(data: prepared) else {
            photoProblem = "That photo couldn't be used. Choose another one."
            return
        }
        do {
            try photos.save(prepared, for: email)
            photo = image
            photoProblem = nil
        } catch {
            photoProblem = "The photo couldn't be saved on this iPhone. Try again."
        }
    }

    public func removePhoto() {
        if let email = signedInEmail() {
            photos.remove(for: email)
        }
        photo = nil
        photoProblem = nil
    }

    /// Forgets what is shown when the session ends; the photo stays on this iPhone for the next
    /// sign-in.
    public func signedOut() {
        profile = nil
        photo = nil
        photoProblem = nil
        saveError = nil
        phase = .loading
    }

    /// The account was deleted: also deletes its photo from this iPhone.
    public func accountDeleted(email: String?) {
        if let email {
            photos.remove(for: email)
        }
        signedOut()
    }

    private static func trimmed(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
