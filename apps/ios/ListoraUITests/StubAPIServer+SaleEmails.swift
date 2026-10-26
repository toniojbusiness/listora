import Foundation

/// Sale email forwarding (Link accounts): the forwarding setup while the provider's confirmation
/// waits for the user, and its settings.
extension StubAPIServer {
    func respondToSaleEmails(method: String, path: String, body: String) -> Data? {
        switch (method, path) {
        case ("GET", "/v1/sale-emails"):
            Self.http(status: "200 OK", body: saleEmails())
        case ("PUT", "/v1/sale-emails/settings"):
            respondToSaleEmailSettings(body: body)
        default:
            nil
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
}
