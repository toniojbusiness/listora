import APIClient
import Foundation
import Observation

/// The sale emails section of Link accounts: the account's forwarding address, how to set
/// forwarding up, the provider's confirmation code or link, and "Ask before delisting". Every
/// status is the server's; the setting shows what the server saved.
@MainActor
@Observable
public final class SaleEmailsModel {
    public private(set) var forwarding: SaleEmailForwarding?
    /// Why the section could not be read, or the setting not saved, safe to show.
    public private(set) var problem: APIFailure?
    public private(set) var isSaving = false

    private let service: any SaleEmailsService

    public init(service: any SaleEmailsService) {
        self.service = service
    }

    public func load() async {
        do {
            forwarding = try await service.get()
            problem = nil
        } catch {
            problem = error
        }
    }

    /// Saves "Ask before delisting"; the switch shows the server's answer, never a guess.
    public func setAskBeforeDelist(_ ask: Bool) async {
        guard !isSaving, forwarding?.askBeforeDelist != ask else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            forwarding = try await service.setAskBeforeDelist(ask)
            problem = nil
        } catch {
            problem = error
        }
    }
}
