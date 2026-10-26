import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import MarketplacesFeature

/// Where a marketplace runs, and which move its row offers: the server says whether the cloud is
/// allowed (docs/features/phone-execution.md), so a marketplace that blocks cloud servers says
/// why and offers no cloud.
@MainActor
struct MarketplaceExecutionTests {
    @Test
    func `a marketplace that blocks cloud servers runs on this iPhone, says why, and offers no cloud`() async throws {
        let service = try FakeConnectionsService(lists: [.success([depopConnection(
            onPhone: true,
            cloudAllowed: false,
        )])])
        let model = MarketplacesModel(service: service, installationID: depopPhone)
        await model.load()
        let execution = try #require(model.rows.first?.execution)
        #expect(execution.text == "Runs on this iPhone")
        #expect(execution.cloudAllowed == false)
        #expect(execution.cloudBlockedReason == depopCloudBlocked)
        #expect(execution.move == nil)
    }

    @Test
    func `offers the cloud only where the server allows it, and this iPhone from the cloud`() throws {
        func execution(_ connection: Components.Schemas.Connection) throws -> MarketplaceRow.Execution {
            try #require(MarketplaceRow(connection: connection, installationID: depopPhone).execution)
        }
        let allowed = try execution(depopConnection(onPhone: true))
        #expect(allowed.move == .toCloud)
        #expect(allowed.cloudBlockedReason == nil)
        // Back on the phone from a cloud the server no longer allows.
        #expect(try execution(depopConnection(onPhone: false, cloudAllowed: false)).move == .toPhone)
        #expect(try execution(depopConnection(onPhone: false)).move == .toPhone)
        let otherPhone = try execution(depopConnection(onPhone: true, cloudAllowed: false, device: UUID().uuidString))
        #expect(otherPhone.text == "Runs on Sam's iPhone")
        #expect(otherPhone.move == nil)
    }

    @Test
    func `a refused move to the cloud keeps the row on this iPhone, with the server's reason`() async throws {
        let refused = APIFailure(
            statusCode: 409,
            code: "marketplace_action_unavailable",
            message: "Depop blocks cloud servers, so Listora runs it from your phone.",
            retryable: false,
        )
        // A row read before the server stopped allowing the cloud still offers it.
        let service = try FakeConnectionsService(
            lists: [.success([depopConnection(onPhone: true)])],
            move: .failure(refused),
        )
        let model = MarketplacesModel(service: service, installationID: depopPhone)
        await model.load()
        try await model.move(#require(model.rows.first), toPhone: false)
        #expect(service.moves == ["depop:cloud"])
        #expect(model.rows.first?.execution?.text == "Runs on this iPhone")
        #expect(model.notice == .init(
            tone: .failure,
            message: "Depop blocks cloud servers, so Listora runs it from your phone.",
        ))
    }
}
