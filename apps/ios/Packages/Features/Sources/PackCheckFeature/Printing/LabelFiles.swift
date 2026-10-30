import Core
import Foundation

/// Where the app gets an order's shipping label to print it (docs/features/pack-check.md,
/// "Printing the label"): the marketplace's own file, downloaded on this iPhone through the
/// seller's session there. The label shows the buyer's name and address, so it never goes
/// through Listora's server: it is downloaded here, printed, and dropped.
protocol LabelFileSource: Sendable {
    /// The label's file (a PDF) at `url`, on `marketplace`'s site.
    func labelFile(at url: URL, marketplace: String) async throws(LabelFileError) -> Data
}

/// Why the label couldn't be downloaded, in the seller's words.
enum LabelFileError: Error, Equatable {
    /// This iPhone holds no session for the marketplace (it was linked on another phone).
    case notLinked
    /// The marketplace asked to sign in again.
    case signedOut
    /// The file isn't a label Listora can print (not a PDF, or too large).
    case notALabel
    /// The marketplace or the network didn't answer; trying again may work.
    case unavailable

    func message(marketplace: String) -> String {
        switch self {
        case .notLinked:
            "Listora can download \(marketplace) labels only on the iPhone you linked \(marketplace) on. "
                + "Open the label on \(marketplace) instead."
        case .signedOut:
            "\(marketplace) asked you to sign in again. Link it again in Link accounts, or open the label on "
                + "\(marketplace)."
        case .notALabel:
            "\(marketplace) didn't send a label Listora can print. Open the label on \(marketplace) instead."
        case .unavailable:
            "Listora couldn't get the label from \(marketplace). Check your connection and try again."
        }
    }
}

/// ``LabelFileSource`` through the sessions this iPhone keeps for the marketplaces (the ones the
/// phone runtime acts in): a plain GET of the file the marketplace named, with the session's
/// cookies for that host, as the marketplace's own page would download it. Only reads: a GET of
/// a label that exists changes nothing.
///
/// It fetches only from the marketplace's own site: https to a host the session's cookies are
/// for (plain http only to this Mac's local stand-ins in a Dev build), and it follows a redirect
/// only to such a host, so the server can't make the phone fetch anything else.
struct SessionLabelFiles: LabelFileSource {
    let sessions: any MarketplaceSessionStore
    /// A Dev build talks to local stand-ins of the marketplaces over plain http.
    let allowsLocalHTTP: Bool
    var urlSession: URLSession = .shared

    /// A label is a few hundred kilobytes; anything near this is not one.
    static let maxBytes = 10_000_000
    /// The cookie whose value a marketplace's own pages send as their web API's bearer token
    /// (Depop's `access_token`, as the phone runtime's reads send it).
    static let bearerCookies = ["depop": "access_token"]

    func labelFile(at url: URL, marketplace: String) async throws(LabelFileError) -> Data {
        let cookies = sessions.cookies(for: marketplace)
        guard !cookies.isEmpty else { throw .notLinked }
        guard Self.allows(url, cookies: cookies, localHTTP: allowsLocalHTTP) else { throw .notALabel }
        let request = Self.request(for: url, marketplace: marketplace, cookies: cookies)
        let guardRedirects = RedirectGuard(cookies: cookies, localHTTP: allowsLocalHTTP)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request, delegate: guardRedirects)
        } catch {
            throw .unavailable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200:
            break
        case 401, 403:
            throw .signedOut
        default:
            throw status >= 500 || status == 429 ? .unavailable : .notALabel
        }
        guard data.count <= Self.maxBytes, Self.isPDF(data) else { throw .notALabel }
        return data
    }

    /// The GET the marketplace's page would make: the session's cookies for the file's host, and
    /// the web API's bearer token where the marketplace's pages send one.
    static func request(for url: URL, marketplace: String, cookies: [StoredCookie]) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("application/pdf", forHTTPHeaderField: "Accept")
        let sent = cookies.filter { $0.isSent(to: url) }
        if !sent.isEmpty {
            request.setValue(
                sent.map { "\($0.name)=\($0.value)" }.joined(separator: "; "),
                forHTTPHeaderField: "Cookie",
            )
        }
        if let name = bearerCookies[marketplace], let token = cookies.first(where: { $0.name == name })?.value {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Whether the phone may fetch `url` with this session: https to a host its cookies are for,
    /// or plain http to a local stand-in in a Dev build.
    static func allows(_ url: URL, cookies: [StoredCookie], localHTTP: Bool) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        switch url.scheme?.lowercased() {
        case "https":
            return cookies.contains { $0.matches(host: host) }
        case "http":
            return localHTTP && (host == "127.0.0.1" || host == "localhost")
        default:
            return false
        }
    }

    static func isPDF(_ data: Data) -> Bool {
        data.starts(with: Data("%PDF-".utf8))
    }

    /// Follows a redirect only to a host the phone may fetch from with this session.
    private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        let cookies: [StoredCookie]
        let localHTTP: Bool

        init(cookies: [StoredCookie], localHTTP: Bool) {
            self.cookies = cookies
            self.localHTTP = localHTTP
        }

        func urlSession(
            _: URLSession,
            task _: URLSessionTask,
            willPerformHTTPRedirection _: HTTPURLResponse,
            newRequest request: URLRequest,
        ) async -> URLRequest? {
            guard let url = request.url, SessionLabelFiles.allows(url, cookies: cookies, localHTTP: localHTTP) else {
                return nil
            }
            return request
        }
    }
}

extension StoredCookie {
    /// Whether the cookie is for `host`: its domain, or one under it.
    func matches(host: String) -> Bool {
        let own = (domain.hasPrefix(".") ? String(domain.dropFirst()) : domain).lowercased()
        return !own.isEmpty && (host == own || host.hasSuffix(".\(own)"))
    }

    /// Whether a browser would send the cookie with a request for `url`.
    func isSent(to url: URL, now: Date = Date()) -> Bool {
        guard let host = url.host()?.lowercased(), matches(host: host) else { return false }
        if secure, url.scheme?.lowercased() != "https" {
            return false
        }
        if let expires, expires <= now {
            return false
        }
        let requested = url.path().isEmpty ? "/" : url.path()
        return path.isEmpty || path == "/" || requested == path || requested
            .hasPrefix(path.hasSuffix("/") ? path : path + "/")
    }
}

/// UI tests' stand-in (`LISTORA_SCRIPTED_PRINTING`): a one-page 4 × 6 in label naming the URL's
/// last path part, with no marketplace call.
struct ScriptedLabelFiles: LabelFileSource {
    func labelFile(at url: URL, marketplace _: String) async throws(LabelFileError) -> Data {
        LabelPrintJob.testLabel(named: url.deletingPathExtension().lastPathComponent)
    }
}
