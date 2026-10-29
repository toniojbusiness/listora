import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Asks the server for compressed answers (`X-Listora-Compression: accepted`; the server's
/// `COMPRESSION_OPT_IN_HEADER`, docs/features/performance.md). URLSession accepts brotli and gzip
/// and decodes them on its own; the server compresses only for builds that send this header, so
/// builds from before compression keep getting every answer as they did.
struct CompressionOptInMiddleware: ClientMiddleware {
    static let header: HTTPField.Name = {
        guard let name = HTTPField.Name("X-Listora-Compression") else {
            preconditionFailure("X-Listora-Compression is a valid header field name")
        }
        return name
    }()

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID _: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?),
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[Self.header] = "accepted"
        return try await next(request, body, baseURL)
    }
}
