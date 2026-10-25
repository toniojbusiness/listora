import AuthenticationServices
import Foundation
import SwiftUI

/// Runs a marketplace's consent page in the system's web authentication sheet and returns the
/// URL it ended on (the app's `listora://` callback). Throws ``WebAuthenticationCanceled`` when
/// the user closes the sheet.
public typealias WebAuthenticator = @MainActor (_ url: URL, _ callbackScheme: String) async throws -> URL

/// The user closed the consent sheet before the marketplace sent them back.
public struct WebAuthenticationCanceled: Error, Equatable {
    public init() {}
}

@MainActor
extension WebAuthenticationSession {
    /// A ``WebAuthenticator`` over SwiftUI's `ASWebAuthenticationSession` wrapper. The session is
    /// ephemeral: it shares no cookies with Safari, so the seller signs in to exactly the account
    /// they mean to connect, and iOS asks no extra permission.
    func authenticator() -> WebAuthenticator {
        { url, scheme in
            do {
                return try await authenticate(
                    using: url,
                    callback: .customScheme(scheme),
                    preferredBrowserSession: .ephemeral,
                    additionalHeaderFields: [:],
                )
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                throw WebAuthenticationCanceled()
            }
        }
    }
}
