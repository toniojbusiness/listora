// The same in-process HTTP stub as AddItemFeatureTests/Support/StubURLProtocol.swift: test
// targets cannot share sources, so each target that stubs URLSession has its own copy.
import Foundation
import Synchronization

/// An HTTP answer from a test server.
struct StubReply: Sendable {
    var status: Int
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body = Data()

    static func json(_ status: Int, _ object: Any) -> StubReply {
        // swiftlint:disable:next force_try
        StubReply(status: status, body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }

    static func error(
        _ status: Int,
        code: String,
        message: String = "Something went wrong.",
        retryable: Bool,
    ) -> StubReply {
        json(status, ["error": ["code": code, "message": message, "retryable": retryable, "requestId": "req-test"]])
    }
}

/// A request a test server received.
struct StubRequest: Sendable {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data

    var path: String {
        url.path(percentEncoded: false)
    }

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// Answers a request, or nil to never answer (a hung connection).
protocol StubServer: Sendable {
    func reply(to request: StubRequest) -> StubReply?
}

/// Routes URLSession requests to in-process test servers by host, so each test owns its hosts
/// and tests can run in parallel. Sessions opt in with ``configuration()``.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private static let servers = Mutex<[String: any StubServer]>([:])

    static func register(_ server: any StubServer, hosts: [String]) {
        servers.withLock { servers in
            for host in hosts {
                servers[host] = server
            }
        }
    }

    static func unregister(hosts: [String]) {
        servers.withLock { servers in
            for host in hosts {
                servers[host] = nil
            }
        }
    }

    /// A foreground session configuration whose requests go to the registered servers.
    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.timeoutIntervalForRequest = 30
        return configuration
    }

    private static func server(for request: URLRequest) -> (any StubServer)? {
        guard let host = request.url?.host() else { return nil }
        return servers.withLock { $0[host] }
    }

    override static func canInit(with request: URLRequest) -> Bool {
        server(for: request) != nil
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let server = Self.server(for: request), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let stubRequest = StubRequest(
            method: request.httpMethod ?? "GET",
            url: url,
            headers: request.allHTTPHeaderFields ?? [:],
            body: request.httpBody ?? request.httpBodyStream.map(Self.readAll) ?? Data(),
        )
        guard let reply = server.reply(to: stubRequest), let response = HTTPURLResponse(
            url: url,
            statusCode: reply.status,
            httpVersion: "HTTP/1.1",
            headerFields: reply.headers,
        )
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readAll(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
