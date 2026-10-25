import APIClient
import Foundation
import Testing
@testable import TasksFeature

@MainActor
struct TaskDetailModelTests {
    let service = FakeTasksService()
    let pasteboard = RecordingPasteboard()
    let photos = RecordingPhotoSaver()

    func model(_ task: UserTask) async -> TaskDetailModel {
        await service.setOpen([task])
        return TaskDetailModel(task: task, service: service, pasteboard: pasteboard, photoSaver: photos)
    }

    @Test
    func `copies each field with one tap`() async {
        let model = await model(Fixtures.task())
        #expect(model.fields.map(\.label) == ["Title", "Description", "Price"])

        #expect(model.copy(model.fields[0]) == "Title copied")
        #expect(model.copy(model.fields[2]) == "Price copied")
        #expect(pasteboard.copied == ["Everlane Linen Shirt", "28.00"])
    }

    @Test
    func `saves the photos to the camera roll in posting order`() async {
        let model = await model(Fixtures.task(photos: ["front", "back", "tag"]))
        await model.savePhotos()

        #expect(model.photoState == .saved(count: 3))
        #expect(await photos.saved.map(\.lastPathComponent) == ["front.jpg", "back.jpg", "tag.jpg"])
    }

    @Test
    func `says why photos were not saved so the user can retry`() async {
        let model = await model(Fixtures.task())
        await photos.fail(with: .notAllowed)
        await model.savePhotos()
        #expect(model.photoState == .failed(
            message: "Listora can't add photos. Allow it in Settings > Listora > Photos, then try again.",
        ))

        await photos.fail(with: nil)
        await model.savePhotos()
        #expect(model.photoState == .saved(count: 3))
    }

    @Test
    func `confirms A list task with the pasted listing link`() async throws {
        let model = await model(Fixtures.task())
        model.listingURL = "  https://poshmark.com/listing/Shirt-64f1a2b3c4d5e6f7a8b9c0d1 \n"
        await model.complete()

        #expect(model.outcome == .completed)
        #expect(model.task.status == .completed)
        let sent = try #require(await service.completions.first)
        #expect(sent.listingURL == "https://poshmark.com/listing/Shirt-64f1a2b3c4d5e6f7a8b9c0d1")
    }

    @Test
    func `confirms A list task without A link too`() async throws {
        let model = await model(Fixtures.task())
        await model.complete()

        #expect(model.outcome == .completed)
        #expect(try #require(await service.completions.first).listingURL == nil)
    }

    @Test
    func `refuses A link that is not A web address before sending`() async {
        let model = await model(Fixtures.task())
        model.listingURL = "my poshmark listing"
        #expect(model.linkProblem == "Paste the listing's link. It starts with https://")
        await model.complete()

        #expect(model.outcome == nil)
        #expect(await service.completions.isEmpty)
    }

    @Test
    func `resends A lost confirmation with the same key and A refused one with A new key`() async {
        let model = await model(Fixtures.task())
        await service.script([.failure(.networkUnavailable), .failure(.refused), .success(())])

        await model.complete()
        #expect(model.problem == APIFailure.networkUnavailable.message)
        #expect(model.outcome == nil)
        await model.complete()
        #expect(model.problem == APIFailure.refused.message)
        await model.complete()
        #expect(model.outcome == .completed)

        let keys = await service.completions.map(\.key)
        #expect(keys.count == 3)
        #expect(keys[0] == keys[1])
        #expect(keys[2] != keys[1])
    }

    @Test
    func `never sends A delist task A link and confirms it as the users own step`() async throws {
        let task = Fixtures.task(
            kind: "delist_manually",
            urgency: "urgent",
            title: "Sold on eBay - delist on Poshmark",
            deepLink: "https://poshmark.com/listing/Shirt-64f1a2b3c4d5e6f7a8b9c0d1",
            fields: [],
            photos: [],
        )
        let model = await model(task)
        #expect(model.presentation.doneTitle == "Done - I removed it")
        #expect(model.deepLink?.absoluteString == "https://poshmark.com/listing/Shirt-64f1a2b3c4d5e6f7a8b9c0d1")
        model.listingURL = "https://poshmark.com/listing/Other-1"
        await model.complete()

        #expect(model.outcome == .completed)
        #expect(try #require(await service.completions.first).listingURL == nil)
    }

    @Test
    func `dismisses A task without counting it done`() async {
        let model = await model(Fixtures.task())
        await model.dismiss()

        #expect(model.outcome == .dismissed)
        #expect(model.task.status == .dismissed)
        #expect(await service.completions.isEmpty)
        #expect(await service.dismissals.count == 1)
    }
}
