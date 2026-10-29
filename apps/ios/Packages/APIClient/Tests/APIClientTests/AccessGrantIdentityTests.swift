import Foundation
import Testing
@testable import APIClient

/// The identity a session names: what the phone keys the marketplace sessions it keeps by
/// (docs/features/phone-execution.md), never the email.
struct AccessGrantIdentityTests {
    private func token(_ claims: [String: Any]) throws -> String {
        func encoded(_ data: Data) -> String {
            data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let header = try JSONSerialization.data(withJSONObject: ["alg": "HS256", "typ": "JWT"])
        let payload = try JSONSerialization.data(withJSONObject: claims)
        return "\(encoded(header)).\(encoded(payload)).c2lnbmF0dXJl"
    }

    private func grant(_ token: String, email: String = "seller@listora.test") -> AccessGrant {
        AccessGrant(accessToken: token, expiresAt: .distantFuture, email: email)
    }

    @Test
    func `is the token's issuer and subject, the same for a renewed token`() throws {
        let issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool"
        let first = try grant(token(["iss": issuer, "sub": "6f1c-user", "iat": 1, "email": "a@listora.test"]))
        let renewed = try grant(token(["iss": issuer, "sub": "6f1c-user", "iat": 2]))

        #expect(first.identity == "\(issuer)#6f1c-user")
        #expect(renewed.identity == first.identity)
    }

    @Test
    func `differs for another account with the same email`() throws {
        let one = try grant(token(["iss": "listora-dev", "sub": "user-1"]))
        let other = try grant(token(["iss": "listora-dev", "sub": "user-2"]))

        #expect(one.email == other.email)
        #expect(one.identity != other.identity)
    }

    @Test
    func `is nil for a token that names no one`() throws {
        #expect(grant("opaque-token").identity == nil)
        #expect(grant("a.b.c").identity == nil)
        #expect(try grant(token(["iss": "listora-dev"])).identity == nil)
        #expect(try grant(token(["iss": "", "sub": "user-1"])).identity == nil)
    }
}
