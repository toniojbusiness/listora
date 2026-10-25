import APIClient
import Foundation
import Testing
@testable import TasksFeature

@MainActor
struct TaskInboxModelTests {
    let service = FakeTasksService()
    let reminders = RecordingReminders()

    func inbox(signedIn: Bool = true, now: Date = Fixtures.created) -> TaskInboxModel {
        TaskInboxModel(service: service, reminders: reminders, isSignedIn: { signedIn }, now: { now })
    }

    @Test
    func `pins urgent tasks above the others and badges every open task`() async {
        await service.setOpen([
            Fixtures.task(
                id: "urgent",
                kind: "delist_manually",
                urgency: "urgent",
                title: "Sold on eBay - delist on Poshmark",
            ),
            Fixtures.task(id: "list"),
            Fixtures.task(
                id: "edit",
                kind: "edit_manually",
                title: "Change the price on Mercari",
                marketplace: "mercari",
            ),
        ])
        let model = inbox()
        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.urgent.map(\.id) == ["urgent"])
        #expect(model.others.map(\.id) == ["list", "edit"])
        #expect(model.openCount == 3)
    }

    @Test
    func `shows the empty state when nothing is pending and clears reminders`() async {
        let model = inbox()
        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.tasks.isEmpty)
        #expect(model.openCount == 0)
        #expect(await reminders.synced == [[]])
    }

    @Test
    func `reminds of urgent tasks only at the times still to come`() async throws {
        let created = Fixtures.created
        await service.setOpen([
            Fixtures.task(
                id: "urgent",
                kind: "delist_manually",
                urgency: "urgent",
                title: "Sold on eBay - delist on Poshmark",
            ),
            Fixtures.task(id: "normal"),
        ])
        // Fifteen minutes after the sale: the 10-minute reminder has passed.
        let model = inbox(now: created.addingTimeInterval(15 * 60))
        await model.load()

        let synced = try #require(await reminders.synced.last)
        #expect(synced.map(\.taskID) == Array(repeating: "urgent", count: 4))
        let offsets: [TimeInterval] = [30 * 60, 60 * 60, 2 * 60 * 60, 3 * 60 * 60]
        let expected = offsets.map { created.addingTimeInterval($0) }
        #expect(synced.map(\.fireAt) == expected)
        #expect(synced.first?.title == "Sold on eBay - delist on Poshmark")
        #expect(Set(synced.map(\.id)).count == synced.count)
    }

    @Test
    func `cancels the reminders of A task once it is done`() async throws {
        let urgent = Fixtures.task(id: "urgent", kind: "delist_manually", urgency: "urgent")
        await service.setOpen([urgent])
        let model = inbox()
        await model.load()
        #expect(try #require(await reminders.synced.last).isEmpty == false)

        await service.setOpen([])
        await model.load()
        #expect(try #require(await reminders.synced.last).isEmpty)
        #expect(model.openCount == 0)
    }

    @Test
    func `keeps the rows when A refresh fails and shows the failure otherwise`() async {
        await service.setOpen([Fixtures.task(id: "list")])
        let model = inbox()
        await model.load()

        await service.failOpen(with: .networkUnavailable)
        await model.load()
        #expect(model.tasks.map(\.id) == ["list"])
        #expect(model.phase == .loaded)

        let fresh = inbox()
        await fresh.load()
        #expect(fresh.phase == .failed(message: APIFailure.networkUnavailable.message))
    }

    @Test
    func `asks nothing of the server when signed out`() async {
        await service.setOpen([Fixtures.task(id: "list")])
        let model = inbox(signedIn: false)
        await model.load()

        #expect(model.phase == .signedOut)
        #expect(model.openCount == 0)
    }
}
