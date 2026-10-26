import Foundation
import Network

/// A tiny HTTP server inside the UI test runner, standing in for the Listora API (and a fake
/// marketplace's sign-in page) so the Share Extension and Link accounts can be driven end to end
/// without a backend or a real marketplace. The simulator shares the Mac's
/// loopback interface, so the extension reaches it at `baseURL`. Answers use the contract's
/// shapes; every request is recorded for the test to check.
final class StubAPIServer: @unchecked Sendable {
    struct Request: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: String
    }

    /// The page Safari opens: one button that shares a Poshmark listing link with the Web Share
    /// API, so the test shares from Safari without loading a marketplace page.
    static let sharePagePath = "/share-test"
    static let sharedListingURL =
        "https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1?utm_source=pm_share"

    private let listener: NWListener
    private let queue = DispatchQueue(label: "StubAPIServer")
    private var recorded: [Request] = []
    private var startFailure: NWError?
    /// Poshmark's link: nil until the app links it, then how many times its check was read.
    private var poshmarkChecks: Int?
    /// Depop's sign-in, whose check did not confirm it: nil until the app asks to check it again,
    /// then how many times that check was read.
    private var depopRechecks: Int?
    private var todayState = TodayState.busy
    /// "Ask before delisting", as the last `PUT /v1/sale-emails/settings` saved it.
    private var askBeforeDelist = false

    /// What `GET /v1/today` answers.
    enum TodayState: Sendable {
        /// A card of every kind, and this week's sales.
        case busy
        /// Nothing to do and no sales.
        case caughtUp
    }

    /// Changes what `GET /v1/today` answers from the next request on.
    func setToday(_ state: TodayState) {
        queue.sync { todayState = state }
    }

    /// Poshmark reads as linked (its check passed) from the next request on.
    func linkPoshmark() {
        queue.sync { poshmarkChecks = 2 }
    }

    private(set) var port: UInt16 = 0

    var baseURL: String {
        "http://127.0.0.1:\(port)"
    }

    var requests: [Request] {
        queue.sync { recorded }
    }

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    /// Starts listening and returns once the port is known.
    func start() throws {
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                ready.signal()
            case let .failed(error):
                self?.startFailure = error
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.serve(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success else { throw StubServerError.notReady }
        if let failure = queue.sync(execute: { startFailure }) {
            throw failure
        }
        port = listener.port?.rawValue ?? 0
    }

    func stop() {
        listener.cancel()
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data {
                buffer.append(data)
            }
            if let request = Self.parse(buffer) {
                recorded.append(request)
                let response = respond(to: request)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            } else if isComplete || error != nil {
                connection.cancel()
            } else {
                receive(on: connection, buffer: buffer)
            }
        }
    }

    /// A complete request (headers plus `Content-Length` bytes of body), or nil while incomplete.
    private static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(bytes: data[..<headerEnd.lowerBound], encoding: .utf8) ?? ""
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].lowercased()
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return Request(
            method: String(requestLine[0]),
            path: String(requestLine[1]),
            headers: headers,
            body: String(bytes: body.prefix(length), encoding: .utf8) ?? "",
        )
    }

    private func respond(to request: Request) -> Data {
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
        switch (request.method, path) {
        case ("GET", Self.sharePagePath):
            return Self.http(status: "200 OK", contentType: "text/html; charset=utf-8", body: Self.sharePage)
        case ("GET", "/v1/items"):
            return Self.http(status: "200 OK", body: Self.itemPage)
        case ("POST", "/v1/items/\(Self.itemId)/listing-links"):
            return Self.http(status: "201 Created", body: Self.linkedListing)
        case ("GET", "/v1/connections"):
            return Self.http(status: "200 OK", body: #"{"data":\#(Self.connections)}"#)
        case ("GET", "/v1/connection-health"):
            return Self.http(status: "200 OK", body: Self.connectionHealth)
        case ("GET", "/v1/today"):
            return Self.http(status: "200 OK", body: todayState == .busy ? Self.busyToday() : Self.caughtUpToday())
        case ("GET", "/v1/today/settings"):
            return Self.http(status: "200 OK", body: #"{"enabled":true,"time":"08:00","timeZone":"UTC"}"#)
        case ("PUT", "/v1/today/settings"):
            // Saved as sent.
            return Self.http(status: "200 OK", body: request.body)
        default:
            if let linking = respondToLinkAccounts(method: request.method, path: path, body: request.body) {
                return linking
            }
            return Self.http(
                status: "404 Not Found",
                body: #"{"error":{"code":"not_found","message":"No stub for this request.","retryable":false,"#
                    + #""requestId":"stub"}}"#,
            )
        }
    }

    private static func http(
        status: String,
        contentType: String = "application/json",
        extraHeaders: [String] = [],
        body: String,
    ) -> Data {
        let bytes = Data(body.utf8)
        let extra = extraHeaders.map { "\($0)\r\n" }.joined()
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(contentType)\r\nContent-Length: \(bytes.count)\r\n"
            + extra + "Connection: close\r\n\r\n"
        return Data(head.utf8) + bytes
    }

    static let itemId = "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d"

    /// The page Safari shares the listing from. It shows how its last share ended ("Sharing",
    /// "Shared", or "Share failed: <error>"), so the element tree of a test that saw no share sheet
    /// tells a share that is still pending from one Safari refused.
    private static let sharePage = """
    <!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Share test</title></head>
    <body style="font: 20px -apple-system; padding: 40px">
    <button id="share" style="font-size: 28px; padding: 24px" onclick="share()">Share listing</button>
    <p id="result"></p>
    <script>
    function share() {
      const result = document.getElementById('result');
      result.textContent = 'Sharing';
      navigator.share({url: '\(sharedListingURL)', title: 'Lululemon Align Pant 25 | Poshmark'}).then(
        () => { result.textContent = 'Shared'; },
        (error) => { result.textContent = 'Share failed: ' + error.name; },
      );
    }
    </script>
    </body></html>
    """

    private static let itemPage = """
    {"data":[{"id":"\(itemId)","sku":"AJ-000184","status":"ready","title":"Lululemon Align pant",
    "brand":"Lululemon","sizeLabel":"6","listings":[],
    "createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"}]}
    """

    private static let linkedListing = """
    {"id":"5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d","itemId":"\(itemId)","marketplace":"poshmark",
    "mode":"assisted","status":"active","statusDisplay":{"tone":"success","label":"Active (you confirmed)"},
    "verification":{"method":"user_confirmation","verifiedAt":"2026-10-24T12:00:00Z"},
    "externalListingId":"64f1a2b3c4d5e6f7a8b9c0d1",
    "externalUrl":"https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1",
    "availableActions":[],"createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"}
    """
}

/// Link accounts: a fake marketplace's sign-in page and the marketplace-sessions endpoints.
extension StubAPIServer {
    /// The actions on a connection: unlinking Poshmark and checking Depop's sign-in again.
    private func respondToConnectionActions(method: String, path: String) -> Data? {
        switch (method, path) {
        case ("DELETE", "/v1/connections/poshmark"):
            // Unlinked: the session is gone, and Poshmark is back to assisted.
            poshmarkChecks = nil
            return Self.http(status: "200 OK", body: Self.assistedConnection("poshmark", "Poshmark"))
        case ("POST", "/v1/connections/depop/checks"):
            // Retry check of the sign-in the server holds: the connection, checking.
            depopRechecks = 0
            return Self.http(status: "202 Accepted", body: Self.depopConnectionChecking)
        default:
            return nil
        }
    }

    private func respondToLinkAccounts(method: String, path: String, body: String) -> Data? {
        switch (method, path) {
        case ("GET", Self.loginPath):
            return Self.http(status: "200 OK", contentType: "text/html; charset=utf-8", body: Self.loginPage)
        case ("POST", Self.loginPath):
            // The fake marketplace signs the user in: a session cookie on its own host, then its
            // account page. The app must hand Listora the cookie, never the password.
            return Self.http(
                status: "303 See Other",
                extraHeaders: [
                    "Location: \(Self.accountPath)",
                    "Set-Cookie: \(Self.sessionCookieName)=\(Self.sessionCookieValue); Path=/; HttpOnly",
                ],
                body: "",
            )
        case ("GET", Self.accountPath):
            return Self.http(status: "200 OK", contentType: "text/html; charset=utf-8", body: Self.accountPage)
        case ("GET", "/v1/marketplace-sessions"):
            let sessions = [poshmarkSession(), Self.mercariSession, depopSession(), Self.ebaySession]
            return Self.http(status: "200 OK", body: #"{"data":["# + sessions.joined(separator: ",") + "]}")
        case ("POST", "/v1/marketplace-sessions/poshmark"):
            poshmarkChecks = 0
            return Self.http(status: "201 Created", body: poshmarkSession())
        case ("GET", "/v1/marketplace-sessions/poshmark"):
            poshmarkChecks = poshmarkChecks.map { $0 + 1 }
            return Self.http(status: "200 OK", body: poshmarkSession())
        case ("GET", "/v1/marketplace-sessions/depop"):
            depopRechecks = depopRechecks.map { $0 + 1 }
            return Self.http(status: "200 OK", body: depopSession())
        case ("GET", "/v1/sale-emails"):
            return Self.http(status: "200 OK", body: saleEmails())
        case ("PUT", "/v1/sale-emails/settings"):
            return respondToSaleEmailSettings(body: body)
        default:
            return respondToConnectionActions(method: method, path: path)
        }
    }

    /// `PUT /v1/sale-emails/settings`: saved as sent (the request is already recorded).
    private func respondToSaleEmailSettings(body: String) -> Data {
        askBeforeDelist = body.replacingOccurrences(of: " ", with: "").contains(#""askBeforeDelist":true"#)
        return Self.http(status: "200 OK", body: saleEmails())
    }

    static let forwardingAddress = "sales+k7q2m4x9p3r6t8w2y5z7@in.listora.test"
    static let forwardingCode = "418273645"

    /// The forwarding setup while Gmail's confirmation waits for the user.
    private func saleEmails() -> String {
        """
        {"address":"\(Self.forwardingAddress)","status":"confirming",
        "statusDisplay":{"tone":"action_needed","label":"Confirm forwarding",
        "detail":"Your email provider sent a confirmation. Enter its code in your email settings, or open its link."},
        "askBeforeDelist":\(askBeforeDelist),
        "steps":["Copy your Listora address.","In Gmail on a computer, open Settings > See all settings > \
        Forwarding and POP/IMAP. Choose Add a forwarding address and paste it."],
        "filter":"from:(poshmark.com OR mercari.com OR depop.com) subject:(sold OR sale)",
        "confirmation":{"provider":"Gmail","code":"\(Self.forwardingCode)",
        "url":"https://mail-settings.google.com/mail/vf-stub","receivedAt":"2026-10-24T12:00:00Z"},
        "lastEmailAt":"2026-10-24T12:00:00Z"}
        """
    }

    // The fake marketplace's sign-in page, standing in for Poshmark's own.

    static let loginPath = "/fake-marketplace/login"
    static let accountPath = "/fake-marketplace/account"
    static let sessionCookieName = "fake_sid"
    static let sessionCookieValue = "stub-session-7f3a9c"

    private static let loginPage = """
    <!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Log in</title>
    <style>
      body { font: 18px -apple-system; padding: 24px; }
      label { display: block; margin-bottom: 16px; }
      input { display: block; width: 100%; box-sizing: border-box; font-size: 18px; padding: 10px; margin-top: 6px; }
    </style></head>
    <body>
    <form method="post" action="\(loginPath)">
      <label>Username <input name="username" autocapitalize="none" autocorrect="off"></label>
      <label>Password <input type="password" name="password"></label>
      <button type="submit" style="font-size: 20px; padding: 12px 24px">Log in</button>
    </form>
    </body></html>
    """

    private static let accountPage = """
    <!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Your closet</title></head>
    <body style="font: 18px -apple-system; padding: 24px"><h1>Signed in as closet_queen</h1></body></html>
    """

    /// Not linked until the app links it; then checking, and linked from the second read on.
    private func poshmarkSession() -> String {
        let (status, tone, label) = switch poshmarkChecks {
        case nil: ("not_linked", "neutral", "Not linked")
        case let .some(reads) where reads < 2: ("checking", "checking", "Checking...")
        case .some: ("linked", "success", "Linked")
        }
        return """
        {"marketplace":"poshmark","status":"\(status)","statusDisplay":{"tone":"\(tone)","label":"\(label)"},
        "login":{"url":"\(baseURL)\(Self.loginPath)","cookieDomains":["127.0.0.1"]}}
        """
    }

    private static let mercariSession = """
    {"marketplace":"mercari","status":"needs_relink","statusDisplay":{"tone":"action_needed",
    "label":"Sign in again","detail":"Mercari logged Listora out. Log in again."},
    "login":{"url":"https://www.mercari.com/login/","cookieDomains":["mercari.com"]},
    "issue":{"code":"session_rejected","message":"Mercari logged Listora out. Log in again.",
    "occurredAt":"2026-10-24T12:00:00Z"}}
    """

    /// Not confirmed (its check failed, as when the cloud browser could not start) until the app
    /// asks to check it again; then checking, and linked from the second read on.
    private func depopSession() -> String {
        let login = #""login":{"url":"https://www.depop.com/login/","cookieDomains":["depop.com"]}"#
        switch depopRechecks {
        case nil:
            let reason = "Listora's browser didn't start, so it couldn't check your Depop sign-in. "
                + "The problem is on Listora's side, not Depop's."
            return #"{"marketplace":"depop","status":"check_failed","statusDisplay":{"tone":"action_needed","#
                + #""label":"Not confirmed","detail":"\#(reason) Check again, or link Depop again if it "#
                + #"keeps failing."},\#(login),"issue":{"code":"browser_unavailable","message":"\#(reason)","#
                + #""occurredAt":"2026-10-25T23:39:46Z"}}"#
        case let .some(reads) where reads < 2:
            return #"{"marketplace":"depop","status":"checking","statusDisplay":{"tone":"checking","#
                + #""label":"Checking..."},\#(login)}"#
        case .some:
            return #"{"marketplace":"depop","status":"linked","statusDisplay":{"tone":"success","#
                + #""label":"Linked"},\#(login)}"#
        }
    }

    private static let ebaySession = """
    {"marketplace":"ebay","status":"not_linked","statusDisplay":{"tone":"neutral","label":"Not linked"},
    "login":{"url":"https://signin.ebay.com/signin/","cookieDomains":["ebay.com"]}}
    """
}

enum StubServerError: Error {
    case notReady
}
