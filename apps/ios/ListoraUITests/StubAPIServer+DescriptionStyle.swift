import Foundation

/// The description style (Settings): Listora's default until a save sends the seller's own.
extension StubAPIServer {
    static let defaultDepopStyle = "Write a title line with the size and one emoji, then the details."

    func respondToDescriptionStyle(method: String, path: String, body: String) -> Data? {
        guard path == "/v1/account/description-style" else { return nil }
        switch method {
        case "GET":
            return Self.http(status: "200 OK", body: descriptionStyle())
        case "PUT":
            // Saved as sent, like the server: a style the body leaves out goes back to the default.
            let sent = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: String] ?? [:]
            depopStyle = sent["depop"]
            return Self.http(status: "200 OK", body: descriptionStyle())
        default:
            return nil
        }
    }

    private func descriptionStyle() -> String {
        let object: [String: Any] = [
            "depop": depopStyle ?? Self.defaultDepopStyle,
            "depopIsDefault": depopStyle == nil,
        ]
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return data.flatMap { String(bytes: $0, encoding: .utf8) } ?? "{}"
    }
}
