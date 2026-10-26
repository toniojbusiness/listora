import Foundation

/// The seller's profile (Settings): the sign-in email and the names the last save sent.
extension StubAPIServer {
    static let profileEmail = "sam.rivera@example.com"

    func respondToProfile(method: String, path: String, body: String) -> Data? {
        guard path == "/v1/account/profile" else { return nil }
        switch method {
        case "GET":
            return Self.http(status: "200 OK", body: profile())
        case "PUT":
            // Saved as sent, like the server: a name the body leaves out is cleared.
            let sent = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: String] ?? [:]
            profileNames = sent
            return Self.http(status: "200 OK", body: profile())
        default:
            return nil
        }
    }

    private func profile() -> String {
        var object = profileNames
        object["email"] = Self.profileEmail
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return data.flatMap { String(bytes: $0, encoding: .utf8) } ?? "{}"
    }
}
