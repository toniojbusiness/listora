import Foundation

/// The Listora API client.
///
/// Placeholder: plan task T-03 generates the real client from the OpenAPI contract with
/// swift-openapi-generator and replaces this type. Until then it only carries the base URL so
/// the app's dependency wiring is in place.
public struct APIClient: Sendable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}
