import Foundation

/// Invites (docs/features/invites.md): an invitee's redemption before they sign in, and the
/// owner's Settings > People, with one person who joined and one invite nobody has used yet.
extension StubAPIServer {
    /// The one code the stub's redemption accepts.
    static let inviteCode = "K7QD-3M9P-XW2T-H8RA"
    static let invitee = "maria@listora.test"
    /// An address whose codes cannot reach it until its first redemption is repeated (SES's sandbox).
    static let unverifiedInvitee = "verify.me@listora.test"
    static let joinedInviteId = "3f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f"

    func respondToInvites(method: String, path: String, body: String) -> Data? {
        switch (method, path) {
        case ("POST", "/v1/invite-redemptions"):
            respondToRedemption(body: body)
        case ("GET", "/v1/invites"):
            Self.http(status: "200 OK", body: #"{"canInvite":true,"data":[\#(invites().joined(separator: ","))]}"#)
        case ("POST", "/v1/invites"):
            respondToNewInvite()
        case ("POST", "/v1/invites/\(Self.joinedInviteId)/revoke"):
            respondToRevoke()
        default:
            nil
        }
    }

    private func respondToRedemption(body: String) -> Data {
        let compact = body.replacingOccurrences(of: " ", with: "")
        guard compact.uppercased().contains(Self.inviteCode.replacingOccurrences(of: "-", with: "")) ||
            compact.uppercased().contains(Self.inviteCode)
        else {
            return Self.http(
                status: "404 Not Found",
                body: #"{"error":{"code":"not_found","#
                    + #""message":"That invite code isn't right. Check it and try again.","#
                    + #""retryable":false,"requestId":"stub"}}"#,
            )
        }
        let email = compact.contains(Self.unverifiedInvitee) ? Self.unverifiedInvitee : Self.invitee
        if email == Self.unverifiedInvitee, !inviteeVerified {
            inviteeVerified = true
            return Self.http(status: "200 OK", body: """
            {"email":"\(email)","status":"email_verification_sent","message":"Amazon Web Services emailed \
            \(email) a link to verify the address, so Listora's sign-in codes can reach it. Open that email \
            and tap the link, then come back and tap Continue."}
            """)
        }
        return Self.http(status: "200 OK", body: """
        {"email":"\(email)","status":"ready","message":"Sign in with \(email). We'll email you a one-time code."}
        """)
    }

    private func respondToNewInvite() -> Data {
        newInviteCreated = true
        return Self.http(status: "201 Created", body: """
        {"invite":\(Self.newInvite),"code":"Q4ZT-8N2V-K7PD-W3MC","link":"listora://invite/Q4ZT-8N2V-K7PD-W3MC",
        "message":"Hi Sam! I'm inviting you to Listora. In the Listora app, tap \\"Sign up with an invite\\" and \
        enter this code: Q4ZT-8N2V-K7PD-W3MC."}
        """)
    }

    private func respondToRevoke() -> Data {
        joinedRevoked = true
        return Self.http(status: "200 OK", body: joinedInvite())
    }

    private func invites() -> [String] {
        (newInviteCreated ? [Self.newInvite] : []) + [joinedInvite(), Self.openInvite]
    }

    private func joinedInvite() -> String {
        let state = joinedRevoked
            ? #""status":"revoked","statusDisplay":{"tone":"failed","label":"Access turned off","#
            + #""detail":"They cannot sign in. Their account and data are kept."},"availableActions":["restore"],"#
            + #""revokedAt":"2026-10-26T12:00:00Z""#
            : #""status":"active","statusDisplay":{"tone":"success","label":"Active"},"availableActions":["revoke"]"#
        return """
        {"id":"\(Self.joinedInviteId)","label":"Maria","codeHint":"H8RA","email":"\(Self.invitee)",
        "redeemedAt":"2026-10-24T12:00:00Z","joinedAt":"2026-10-24T12:05:00Z",\(state),
        "createdAt":"2026-10-24T11:00:00Z"}
        """
    }

    private static let openInvite = """
    {"id":"6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d","codeHint":"7XQ2","status":"open",
    "statusDisplay":{"tone":"neutral","label":"Not used yet"},"expiresAt":"2026-11-03T11:00:00Z",
    "availableActions":["revoke"],"createdAt":"2026-10-27T11:00:00Z"}
    """

    private static let newInvite = """
    {"id":"9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b","label":"Sam","codeHint":"W3MC","status":"open",
    "statusDisplay":{"tone":"neutral","label":"Not used yet"},"expiresAt":"2026-11-03T13:00:00Z",
    "availableActions":["revoke"],"createdAt":"2026-10-27T13:00:00Z"}
    """
}
