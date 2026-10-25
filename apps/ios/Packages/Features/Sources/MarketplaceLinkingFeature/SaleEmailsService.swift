import APIClient
import DesignSystem
import Foundation
import ListoraAPI

/// The sale email forwarding setup, as the server reports it: the account's private address,
/// the setup steps, the email provider's confirmation while it waits, and the "ask before
/// auto-delist" setting. The status is the server's: forwarding reads as working only once a
/// marketplace email passed Listora's sender checks.
public struct SaleEmailForwarding: Equatable, Sendable {
    public struct Confirmation: Equatable, Sendable {
        public let provider: String
        public let code: String?
        public let url: URL?
    }

    /// Absent where this Listora receives no email yet.
    public let address: String?
    public let isAvailable: Bool
    public let statusLabel: String
    public let statusTone: StatusLabel.Tone
    public let statusDetail: String?
    public let askBeforeDelist: Bool
    public let steps: [String]
    /// The email search that finds the marketplaces' sold emails.
    public let filter: String
    public let confirmation: Confirmation?
    public let lastSaleEmailAt: Date?

    public init(
        address: String?,
        isAvailable: Bool,
        statusLabel: String,
        statusTone: StatusLabel.Tone,
        statusDetail: String? = nil,
        askBeforeDelist: Bool,
        steps: [String],
        filter: String,
        confirmation: Confirmation? = nil,
        lastSaleEmailAt: Date? = nil,
    ) {
        self.address = address
        self.isAvailable = isAvailable
        self.statusLabel = statusLabel
        self.statusTone = statusTone
        self.statusDetail = statusDetail
        self.askBeforeDelist = askBeforeDelist
        self.steps = steps
        self.filter = filter
        self.confirmation = confirmation
        self.lastSaleEmailAt = lastSaleEmailAt
    }
}

/// The API calls of the sale emails section.
public protocol SaleEmailsService: Sendable {
    func get() async throws(APIFailure) -> SaleEmailForwarding
    func setAskBeforeDelist(_ ask: Bool) async throws(APIFailure) -> SaleEmailForwarding
}

/// `SaleEmailsService` on the Listora API.
public struct APISaleEmailsService: SaleEmailsService {
    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func get() async throws(APIFailure) -> SaleEmailForwarding {
        let output = try await call { try await api.client.getSaleEmails() }
        switch output {
        case let .ok(response):
            return try SaleEmailForwarding(decode { try response.body.json })
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func setAskBeforeDelist(_ ask: Bool) async throws(APIFailure) -> SaleEmailForwarding {
        let output = try await call {
            try await api.client.replaceSaleEmailSettings(body: .json(.init(askBeforeDelist: ask)))
        }
        switch output {
        case let .ok(response):
            return try SaleEmailForwarding(decode { try response.body.json })
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    private func call<Output>(_ body: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await body()
        } catch {
            throw APIFailure(error)
        }
    }

    private func decode<Value>(_ body: () throws -> Value) throws(APIFailure) -> Value {
        do {
            return try body()
        } catch {
            throw APIFailure(error)
        }
    }
}

extension SaleEmailForwarding {
    init(_ forwarding: Components.Schemas.SaleEmails) {
        self.init(
            address: forwarding.address,
            isAvailable: forwarding.status.value1 != .unavailable && forwarding.address != nil,
            statusLabel: forwarding.statusDisplay.label,
            statusTone: StatusLabel.Tone(forwarding.statusDisplay.tone),
            statusDetail: forwarding.statusDisplay.detail,
            askBeforeDelist: forwarding.askBeforeDelist,
            steps: forwarding.steps,
            filter: forwarding.filter,
            confirmation: forwarding.confirmation.map { confirmation in
                Confirmation(
                    provider: confirmation.provider,
                    code: confirmation.code,
                    // Only a web link the provider sent; the app opens it only on the user's tap.
                    url: confirmation.url.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil },
                )
            },
            lastSaleEmailAt: forwarding.lastSaleEmailAt,
        )
    }
}
