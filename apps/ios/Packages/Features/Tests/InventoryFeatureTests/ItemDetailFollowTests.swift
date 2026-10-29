import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

/// The item screen follows a running change by waiting on the server (`waitForItemChange`),
/// reading the item only when the wait says it changed, and on a timer only while it can't wait.
@MainActor
@Suite("Item detail follows changes")
struct ItemDetailFollowTests {
    private static let working = Fixtures.item(listings: [Fixtures.listing(
        latest: Fixtures.operation(status: .running, label: "Delisting...", tone: .inProgress),
    )])
    private static let settled = Fixtures.item(listings: [Fixtures.listing(
        latest: Fixtures.operation(status: .succeeded, label: "Ended (confirmed by eBay)", tone: .success),
    )])

    @Test
    func `reads the item only when the wait says it changed, passing each answer's token on`() async throws {
        let service = FakeInventoryService()
        service.item = Self.working
        service.changes = [
            .init(changed: true, token: "t1"),
            .init(changed: false, token: "t1"),
            .init(changed: true, token: "t2"),
        ]
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()
        let start = service.calls.count
        let following = Task { await model.followChanges() }
        try await eventually { service.calls.contains("wait:t2") }
        following.cancel()
        await following.value
        let calls = Array(service.calls[start...].prefix(6))
        #expect(calls == ["wait:none", "item", "wait:t1", "wait:t1", "item", "wait:t2"])
    }

    @Test
    func `stops waiting once the change settled`() async throws {
        let service = FakeInventoryService()
        service.item = Self.working
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()
        #expect(model.isWorking)
        service.item = Self.settled
        let start = service.calls.count
        let following = Task { await model.followChanges() }
        try await eventually { !model.isWorking }
        try await Task.sleep(for: .milliseconds(200))
        following.cancel()
        await following.value
        #expect(Array(service.calls[start...]) == ["wait:none", "item"])
    }

    @Test
    func `reads the item on a timer while the wait fails`() async throws {
        let service = FakeInventoryService()
        service.item = Self.working
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()
        service.failingCall = "wait"
        service.failure = .networkUnavailable
        let start = service.calls.count
        let following = Task { await model.followChanges() }
        try await eventually { service.calls[start...].contains("item") }
        following.cancel()
        await following.value
        #expect(service.calls[start...].prefix(2) == ["wait:none", "item"])
    }

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0 ..< 200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("the condition never became true")
    }
}
