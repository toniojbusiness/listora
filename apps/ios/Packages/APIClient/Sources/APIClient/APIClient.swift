import Foundation
import ListoraAPI
import OpenAPIRuntime
import OpenAPIURLSession

/// The Listora API client: the `Client` generated from the OpenAPI contract
/// (`packages/api-contract`), sending requests over URLSession with the signed-in session's bearer
/// token.
///
/// Call operations on ``client``. Every POST takes an `Idempotency-Key`, reused on every retry of
/// the same action, and every failure converts to ``APIFailure``.
public struct APIClient: Sendable {
    public let baseURL: URL
    public let client: Client

    public init(baseURL: URL, accessTokens: any AccessTokenProvider, session: URLSession = .shared) {
        self.baseURL = baseURL
        client = Client(
            serverURL: baseURL,
            configuration: Configuration(dateTranscoder: ISO8601Timestamps()),
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [BearerAuthMiddleware(accessTokens: accessTokens), CompressionOptInMiddleware()],
        )
    }
}

/// Reads and writes the contract's `Timestamp` (RFC 3339 in UTC). The server sends fractional
/// seconds (`2026-10-24T12:00:00.000Z`), which the runtime's default transcoder rejects, so this
/// accepts timestamps with or without them and writes them with milliseconds.
struct ISO8601Timestamps: DateTranscoder {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    func encode(_ date: Date) throws -> String {
        Self.fractional.format(date)
    }

    func decode(_ string: String) throws -> Date {
        if let date = try? Self.fractional.parse(string) {
            return date
        }
        return try Self.whole.parse(string)
    }
}
