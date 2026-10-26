import Foundation

extension StubAPIServer {
    /// The one code the stub's dev sign-in accepts.
    static let devSignInCode = "123456"

    /// The API's dev sign-in driver (docs/features/auth.md): every email gets a code, and the code
    /// is always ``devSignInCode``.
    func respondToDevSignIn(_ request: Request, path: String) -> Data? {
        switch (request.method, path) {
        case ("POST", "/dev/auth/codes"):
            return Self.http(status: "202 Accepted", body: #"{"expiresInSeconds":600}"#)
        case ("POST", "/dev/auth/sessions"):
            guard request.body.contains(#""code":"\#(Self.devSignInCode)""#) else {
                return Self.http(
                    status: "401 Unauthorized",
                    body: #"{"error":{"code":"unauthenticated","message":"That sign-in code is not correct.","#
                        + #""retryable":false,"requestId":"stub"}}"#,
                )
            }
            return Self.http(
                status: "200 OK",
                body: #"{"accessToken":"stub-token","tokenType":"Bearer","expiresInSeconds":86400}"#,
            )
        default:
            return nil
        }
    }
}
