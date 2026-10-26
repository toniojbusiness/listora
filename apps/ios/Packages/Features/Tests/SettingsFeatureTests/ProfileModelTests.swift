import APIClient
import Foundation
import ImageIO
import Testing
import UIKit
@testable import SettingsFeature

/// The profile: what the server has, saving both names (trimmed, an empty one cleared), a failed
/// save that keeps the seller's typing, and the photo kept on this iPhone only.
@MainActor
struct ProfileModelTests {
    private final class FakeService: ProfileService, @unchecked Sendable {
        var stored = Profile(email: "sam.rivera@example.com", displayName: nil, businessName: nil)
        var loadFailure: APIFailure?
        var saveFailure: APIFailure?
        private(set) var saves: [[String?]] = []

        func profile() async throws(APIFailure) -> Profile {
            if let loadFailure {
                throw loadFailure
            }
            return stored
        }

        func save(displayName: String?, businessName: String?) async throws(APIFailure) -> Profile {
            saves.append([displayName, businessName])
            if let saveFailure {
                throw saveFailure
            }
            stored = Profile(email: stored.email, displayName: displayName, businessName: businessName)
            return stored
        }
    }

    private final class MemoryPhotos: AvatarStore, @unchecked Sendable {
        var files: [String: Data] = [:]
        func photo(for email: String) -> Data? {
            files[email]
        }

        func save(_ photo: Data, for email: String) throws {
            files[email] = photo
        }

        func remove(for email: String) {
            files[email] = nil
        }
    }

    private final class Session {
        var email: String? = "sam.rivera@example.com"
    }

    private func model(_ service: FakeService, _ photos: MemoryPhotos = MemoryPhotos(), session: Session = Session())
        -> ProfileModel
    {
        ProfileModel(service: service, photos: photos, signedInEmail: { session.email })
    }

    private static func photoData(width: Int = 2000, height: Int = 1500) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.jpegData(withCompressionQuality: 0.9) { context in
            UIColor.brown.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    @Test
    func `shows the session's email and its initial until the server's profile arrives`() async {
        let service = FakeService()
        let profile = model(service)
        #expect(profile.phase == .loading)
        #expect(profile.email == "sam.rivera@example.com")
        #expect(profile.initials == "S")
        #expect(profile.title == "Add your name")
        await profile.load()
        #expect(profile.phase == .loaded)
        #expect(profile.profile == service.stored)
    }

    @Test
    func `saves both names trimmed, and an empty field clears its name`() async {
        let service = FakeService()
        let profile = model(service)
        await profile.load()
        profile.beginEditing()
        #expect(!profile.hasChanges)
        profile.draftName = "  Sam Rivera "
        profile.draftBusinessName = "Second Spin Vintage"
        #expect(profile.hasChanges)
        #expect(await profile.save())
        #expect(service.saves.last == ["Sam Rivera", "Second Spin Vintage"])
        #expect(profile.title == "Sam Rivera")
        #expect(profile.initials == "SR")

        profile.beginEditing()
        #expect(profile.draftName == "Sam Rivera")
        profile.draftName = "   "
        #expect(await profile.save())
        #expect(service.saves.last == [nil, "Second Spin Vintage"])
        #expect(profile.title == "Second Spin Vintage")
        #expect(profile.initials == "SS")
    }

    @Test
    func `a failed save keeps what the seller typed, says why, and saves nothing`() async {
        let service = FakeService()
        let profile = model(service)
        await profile.load()
        profile.beginEditing()
        profile.draftName = "Sam"
        service.saveFailure = APIFailure(
            statusCode: 503,
            code: "unavailable",
            message: "Listora is busy. Try again.",
            retryable: true,
        )
        #expect(await profile.save() == false)
        #expect(profile.saveError == "Listora is busy. Try again.")
        #expect(profile.draftName == "Sam")
        #expect(profile.profile?.displayName == nil)
        #expect(profile.hasChanges)

        service.saveFailure = nil
        #expect(await profile.save())
        #expect(profile.saveError == nil)
    }

    @Test
    func `a failed first read says why, and a later failure keeps the profile shown`() async {
        let service = FakeService()
        service.loadFailure = .networkUnavailable
        let profile = model(service)
        await profile.load()
        #expect(profile.phase == .failed(message: APIFailure.networkUnavailable.message))
        service.loadFailure = nil
        await profile.load()
        #expect(profile.phase == .loaded)
        service.loadFailure = .networkUnavailable
        await profile.load()
        #expect(profile.phase == .loaded)
        #expect(profile.profile != nil)
    }

    @Test
    func `keeps a small copy of the photo on this iPhone, per person, until removed`() async throws {
        let photos = MemoryPhotos()
        let session = Session()
        let profile = model(FakeService(), photos, session: session)
        await profile.setPhoto(Self.photoData())
        let saved = try #require(photos.files["sam.rivera@example.com"])
        let image = try #require(UIImage(data: saved))
        #expect(max(image.size.width * image.scale, image.size.height * image.scale) <= CGFloat(AvatarPhoto.maxPixels))
        #expect(profile.photo != nil)

        // Signing out forgets it on screen; the same person's next sign-in shows it again.
        profile.signedOut()
        #expect(profile.photo == nil)
        await profile.load()
        #expect(profile.photo != nil)

        profile.removePhoto()
        #expect(profile.photo == nil)
        #expect(photos.files.isEmpty)
    }

    @Test
    func `refuses data that is not a photo`() async {
        let photos = MemoryPhotos()
        let profile = model(FakeService(), photos)
        await profile.setPhoto(Data("not a photo".utf8))
        #expect(profile.photo == nil)
        #expect(profile.photoProblem == "That photo couldn't be used. Choose another one.")
        #expect(photos.files.isEmpty)
    }

    @Test
    func `deleting the account deletes its photo`() async {
        let photos = MemoryPhotos()
        let profile = model(FakeService(), photos)
        await profile.setPhoto(Self.photoData(width: 100, height: 100))
        profile.accountDeleted(email: "sam.rivera@example.com")
        #expect(photos.files.isEmpty)
        #expect(profile.profile == nil)
    }

    @Test
    func `the photo file is named by a hash, not the address, and strips the original's metadata`() throws {
        let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileAvatarStore(directory: directory)
        let prepared = try #require(AvatarPhoto.prepared(Self.photoData(width: 600, height: 400)))
        try store.save(prepared, for: "Sam.Rivera@example.com")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        #expect(names.count == 1)
        #expect(names.allSatisfy { !$0.contains("sam") && $0.hasSuffix(".jpg") })
        #expect(store.photo(for: "sam.rivera@example.com") == prepared)
        let source = try #require(CGImageSourceCreateWithData(prepared as CFData, nil))
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        #expect(properties?[kCGImagePropertyGPSDictionary] == nil)
        store.remove(for: "sam.rivera@example.com")
        #expect(store.photo(for: "sam.rivera@example.com") == nil)
    }
}
