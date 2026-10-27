import Foundation
import Network
import OSLog
import Testing
@testable import PhoneExecutionFeature

/// Runs inside the app, with WebKit: a phone run's page load waits for the page it asked for, on
/// every load of a long run, so a step never reads the page before it.
@MainActor
struct PhoneMarketplacePageIntegrationTests {
    @Test
    func `every load waits for its own page, never one before it`() async throws {
        let server = try await SlowPageServer.start()
        defer { server.stop() }
        let page = MarketplacePage(
            origins: [server.origin],
            logger: Logger(subsystem: "com.listora.tests", category: "page"),
        )
        defer { page.close() }

        for number in 1 ... 60 {
            let url = try #require(URL(string: "\(server.origin)/page/\(number)"))
            _ = try await page.navigate(url, timeout: .seconds(10))
            let title = try await page.evaluate("return document.title;", [:], timeout: .seconds(5))
            #expect(title as? String == String(number), "load \(number) showed \(title)")
        }
    }
}

/// A local web server whose every page comes a moment late, as a marketplace's do, titled with
/// the number in its path.
private final class SlowPageServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "slow-page-server")
    let origin: String

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        origin = "http://127.0.0.1:\(port)"
    }

    static func start() async throws -> SlowPageServer {
        let listener = try NWListener(using: .tcp, on: .any)
        let queue = DispatchQueue(label: "slow-page-server-start")
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { connection in
                SlowPageServer.serve(connection)
            }
            listener.start(queue: queue)
        }
        return SlowPageServer(listener: listener, port: port)
    }

    func stop() {
        listener.cancel()
    }

    private static func serve(_ connection: NWConnection) {
        let queue = DispatchQueue(label: "slow-page-connection")
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let number = path.split(separator: "/").last.map(String.init) ?? "0"
            let body = "<!doctype html><html><head><title>\(number)</title></head><body>\(number)</body></html>"
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(body.utf8.count)\r\n"
                + "Cache-Control: no-store\r\nConnection: close\r\n\r\n\(body)"
            queue.asyncAfter(deadline: .now() + .milliseconds(150)) {
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
    }
}
