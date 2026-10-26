import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SettingsFeature

/// Settings > Delete account: a success signs out and names the marketplaces to clean up by hand;
/// any failure deletes nothing and can be tried again.
@MainActor
struct AccountDeletionModelTests {
    private final class FakeService: AccountDeletionService, @unchecked Sendable {
        var result: Result<Components.Schemas.AccountDeletion, APIFailure>

        init(_ result: Result<Components.Schemas.AccountDeletion, APIFailure>) {
            self.result = result
        }

        func deleteAccount() async throws(APIFailure) -> Components.Schemas.AccountDeletion {
            try result.get()
        }
    }

    private final class Session {
        var signedIn = true
    }

    private func access(_ marketplace: Components.Schemas.KnownMarketplace, _ name: String?, revoked: Bool)
        -> Components.Schemas.MarketplaceAccessRevocation
    {
        .init(marketplace: .init(value1: marketplace), displayName: name, revoked: revoked)
    }

    @Test
    func `a deletion signs out and lists the marketplaces whose access was not revoked yet`() async {
        let session = Session()
        let service = FakeService(.success(.init(
            deletedAt: Date(),
            marketplaceAccess: [access(.ebay, "thrift_seller", revoked: false), access(.depop, nil, revoked: true)],
        )))
        let model = AccountDeletionModel(
            service: service,
            isSignedIn: { session.signedIn },
            signOut: { session.signedIn = false },
        )
        #expect(model.isSignedIn)
        await model.delete()
        #expect(model.phase == .deleted(revokeManually: ["eBay (thrift_seller)"]))
        #expect(!session.signedIn)
        #expect(!model.isSignedIn)
    }

    @Test
    func `a failure deletes nothing, stays signed in, and can be tried again`() async {
        let session = Session()
        let service = FakeService(.failure(APIFailure(
            statusCode: 403,
            code: "forbidden",
            message: "Other people use this account.",
            retryable: false,
        )))
        let model = AccountDeletionModel(
            service: service,
            isSignedIn: { session.signedIn },
            signOut: { session.signedIn = false },
        )
        await model.delete()
        #expect(model.phase == .failed(message: "Other people use this account."))
        #expect(session.signedIn)

        service.result = .success(.init(deletedAt: Date(), marketplaceAccess: []))
        await model.delete()
        #expect(model.phase == .deleted(revokeManually: []))
    }

    @Test
    func `a lost answer to an earlier try reads as deleted`() async {
        let session = Session()
        let service = FakeService(.failure(APIFailure(
            statusCode: 401,
            code: "unauthenticated",
            message: "Sign in again.",
            retryable: false,
        )))
        let model = AccountDeletionModel(
            service: service,
            isSignedIn: { session.signedIn },
            signOut: { session.signedIn = false },
        )
        await model.delete()
        #expect(model.phase == .deleted(revokeManually: []))
        #expect(!session.signedIn)
    }
}
