import APIClient
import Foundation
import ListoraAPI
import Observation

/// Deletes the signed-in person's account (`deleteAccount`), which App Store Review Guideline
/// 5.1.1(v) requires in the app. A success is final: the server has deleted the data and the
/// session stops working, so the app signs out. Any error means nothing was deleted and the
/// seller can try again (docs/features/auth.md, Account deletion).
@MainActor
@Observable
public final class AccountDeletionModel {
    public enum Phase: Equatable {
        case ready
        case deleting
        /// Deleted and signed out. `revokeManually` names the marketplaces (and the seller's name
        /// there) that hadn't confirmed revoking Listora's access, so the seller removes it there.
        case deleted(revokeManually: [String])
        /// Nothing was deleted; `message` is safe to show.
        case failed(message: String)
    }

    public private(set) var phase: Phase = .ready
    /// Settings offers deletion only while someone is signed in.
    public private(set) var isSignedIn: Bool
    private let service: any AccountDeletionService
    private let checkSignedIn: @MainActor () -> Bool
    private let signOut: @MainActor () -> Void

    public init(
        service: any AccountDeletionService,
        isSignedIn: @escaping @MainActor () -> Bool,
        signOut: @escaping @MainActor () -> Void,
    ) {
        self.service = service
        checkSignedIn = isSignedIn
        self.signOut = signOut
        self.isSignedIn = isSignedIn()
    }

    /// Reads the session again (it ends on sign-out, expiry, or a rejected token).
    public func refresh() {
        isSignedIn = checkSignedIn()
    }

    public func delete() async {
        guard phase != .deleting else { return }
        phase = .deleting
        do {
            let deletion = try await service.deleteAccount()
            signOut()
            isSignedIn = false
            phase = .deleted(revokeManually: deletion.marketplaceAccess.filter { !$0.revoked }.map(Self.describe))
        } catch {
            if error.isUnauthenticated {
                // The answer to an earlier try was lost and the account is already gone (the
                // contract's rule), or the session had ended: either way there is nothing left here.
                signOut()
                isSignedIn = false
                phase = .deleted(revokeManually: [])
            } else {
                phase = .failed(message: error.message)
            }
        }
    }

    /// Back to the start, after the seller read the result.
    public func reset() {
        phase = .ready
    }

    /// "eBay (thrift_seller)".
    static func describe(_ access: Components.Schemas.MarketplaceAccessRevocation) -> String {
        let id = access.marketplace.value1?.rawValue ?? access.marketplace.value2 ?? ""
        let name = switch id {
        case "ebay": "eBay"
        case "depop": "Depop"
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        default: id
        }
        guard let displayName = access.displayName, !displayName.isEmpty else { return name }
        return "\(name) (\(displayName))"
    }
}

/// The account call, a protocol so the model's tests run against a fake.
public protocol AccountDeletionService: Sendable {
    func deleteAccount() async throws(APIFailure) -> Components.Schemas.AccountDeletion
}

/// ``AccountDeletionService`` over the generated client.
public struct APIAccountDeletionService: AccountDeletionService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func deleteAccount() async throws(APIFailure) -> Components.Schemas.AccountDeletion {
        let output: Operations.DeleteAccount.Output
        do {
            output = try await client.deleteAccount()
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .forbidden(response): throw APIFailure(statusCode: 403, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
