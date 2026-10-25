import APIClient
import Foundation
import Synchronization
import Testing

struct CognitoSignInClientTests {
    /// A made-up region per test, so its stubbed host is its own and tests run in parallel.
    private let region = "test-\(UUID().uuidString.lowercased())"
    private var host: String {
        "cognito-idp.\(region).amazonaws.com"
    }

    private func client(now: Date = Date(timeIntervalSince1970: 1000)) -> CognitoSignInClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DevAuthStub.self]
        return CognitoSignInClient(
            region: region,
            clientID: "appclient123",
            session: URLSession(configuration: configuration),
            now: { now },
        )
    }

    /// The Cognito operation (`X-Amz-Target`) and JSON body of a request.
    private static func call(_ request: URLRequest) -> (String, [String: Any]) {
        let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
        let data = request.httpBodyStream.map(Self.read) ?? request.httpBody ?? Data()
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (target.replacingOccurrences(of: "AWSCognitoIdentityProviderService.", with: ""), body)
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static let tokens = #"{"AuthenticationResult":{"IdToken":"id-1","AccessToken":"access-1","#
        + #""RefreshToken":"refresh-1","ExpiresIn":3600,"TokenType":"Bearer"}}"#

    @Test
    func `emails a code with USER_AUTH and EMAIL_OTP, then exchanges it for the ID token`() async throws {
        let requests = Mutex<[URLRequest]>([])
        DevAuthStub.answer(host: host) { request in
            requests.withLock { $0.append(request) }
            return switch Self.call(request).0 {
            case "InitiateAuth":
                (200, #"{"ChallengeName":"EMAIL_OTP","Session":"s-1","ChallengeParameters":{"USERNAME":"uuid-1"}}"#)
            case "RespondToAuthChallenge":
                (200, Self.tokens)
            default:
                (400, #"{"__type":"UnexpectedOperation"}"#)
            }
        }

        let client = client()
        let challenge = try await client.requestCode(email: "owner@example.com")
        let grant = try await client.signIn(challenge, code: "12345678")

        // The API reads the verified email from the ID token, so that is the bearer token.
        #expect(grant == AccessGrant(
            accessToken: "id-1",
            expiresAt: Date(timeIntervalSince1970: 1000 + 3600),
            email: "owner@example.com",
            refreshToken: "refresh-1",
        ))
        let sentRequests = requests.withLock { $0 }
        let sent = sentRequests.map(Self.call)
        // A public client: plain JSON, no AWS credentials.
        for request in sentRequests {
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-amz-json-1.1")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        }
        #expect(sent.map(\.0) == ["InitiateAuth", "RespondToAuthChallenge"])
        #expect(sent[0].1["AuthFlow"] as? String == "USER_AUTH")
        #expect(sent[0].1["ClientId"] as? String == "appclient123")
        #expect(sent[0].1["AuthParameters"] as? [String: String] == [
            "USERNAME": "owner@example.com", "PREFERRED_CHALLENGE": "EMAIL_OTP",
        ])
        #expect(sent[1].1["ChallengeName"] as? String == "EMAIL_OTP")
        #expect(sent[1].1["Session"] as? String == "s-1")
        // The answer names the user as Cognito does.
        #expect(sent[1].1["ChallengeResponses"] as? [String: String] == [
            "USERNAME": "uuid-1", "EMAIL_OTP_CODE": "12345678",
        ])
    }

    @Test
    func `refuses a user who cannot get an emailed code`() async {
        DevAuthStub.answer(host: host) { _ in
            (200, #"{"ChallengeName":"SELECT_CHALLENGE","Session":"s-1","AvailableChallenges":["PASSWORD"]}"#)
        }
        let client = client()
        let failure = await #expect(throws: APIFailure.self) {
            try await client.requestCode(email: "owner@example.com")
        }
        #expect(failure?.message == "This account can't sign in with an emailed code.")
    }

    @Test(arguments: [
        ("CodeMismatchException", "That code isn't right. Check the email and try again.", false, false),
        ("ExpiredCodeException", "That code has expired. Send a new one.", false, false),
        ("NotAuthorizedException", "This sign-in has ended. Send a new code.", false, true),
        (
            "com.amazonaws.cognito#TooManyRequestsException",
            "Too many tries. Wait a few minutes, then try again.",
            true,
            false,
        ),
        ("CodeDeliveryFailureException", "Listora couldn't email the code. Try again in a few minutes.", true, false),
    ])
    func `shows each Cognito failure in the app's words`(
        type: String, message: String, retryable: Bool, unauthenticated: Bool,
    ) async {
        DevAuthStub.answer(host: host) { _ in (400, #"{"__type":"\#(type)","message":"for developers"}"#) }
        let client = client()
        let failure = await #expect(throws: APIFailure.self) {
            try await client.requestCode(email: "owner@example.com")
        }
        #expect(failure?.message == message)
        #expect(failure?.retryable == retryable)
        #expect(failure?.isUnauthenticated == unauthenticated)
    }

    @Test
    func `a server error is retryable and no connection reads as offline`() async {
        DevAuthStub.answer(host: host) { _ in (503, "") }
        let client = client()
        let failure = await #expect(throws: APIFailure.self) {
            try await client.requestCode(email: "owner@example.com")
        }
        #expect(failure?.retryable == true)
        #expect(failure?.code == "service_unavailable")

        let offline = CognitoSignInClient(region: "test-offline", clientID: "c", session: URLSession(
            configuration: { () -> URLSessionConfiguration in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [OfflineStub.self]
                return configuration
            }(),
        ))
        let unreachable = await #expect(throws: APIFailure.self) {
            try await offline.requestCode(email: "owner@example.com")
        }
        #expect(unreachable == .networkUnavailable)
    }

    @Test
    func `renews the token with the refresh token, which it keeps unless Cognito rotates it`() async throws {
        let requests = Mutex<[URLRequest]>([])
        DevAuthStub.answer(host: host) { request in
            requests.withLock { $0.append(request) }
            return (200, #"{"AuthenticationResult":{"IdToken":"id-2","AccessToken":"a-2","ExpiresIn":3600}}"#)
        }
        let old = AccessGrant(accessToken: "id-1", expiresAt: .distantPast, email: "o@e.com", refreshToken: "r-1")

        let renewed = try await client(now: Date(timeIntervalSince1970: 5000)).refresh(old)

        #expect(renewed == AccessGrant(
            accessToken: "id-2",
            expiresAt: Date(timeIntervalSince1970: 5000 + 3600),
            email: "o@e.com",
            refreshToken: "r-1",
        ))
        let body = try #require(requests.withLock { $0.first }.map(Self.call)?.1)
        #expect(body["AuthFlow"] as? String == "REFRESH_TOKEN_AUTH")
        #expect(body["AuthParameters"] as? [String: String] == ["REFRESH_TOKEN": "r-1"])
    }

    @Test
    func `a refresh token that no longer works means signing in again`() async {
        DevAuthStub.answer(host: host) { _ in (400, #"{"__type":"NotAuthorizedException"}"#) }
        let grant = AccessGrant(accessToken: "id-1", expiresAt: .distantPast, email: "o@e.com", refreshToken: "r-1")
        let client = client()
        let failure = await #expect(throws: APIFailure.self) { try await client.refresh(grant) }
        #expect(failure?.isUnauthenticated == true)
    }

    @Test
    func `revokes the refresh token at sign-out`() async throws {
        let requests = Mutex<[URLRequest]>([])
        DevAuthStub.answer(host: host) { request in
            requests.withLock { $0.append(request) }
            return (200, "{}")
        }
        let grant = AccessGrant(accessToken: "id-1", expiresAt: .distantFuture, email: "o@e.com", refreshToken: "r-1")

        try await client().revoke(grant)

        let sent = requests.withLock { $0 }.map(Self.call)
        #expect(sent.map(\.0) == ["RevokeToken"])
        #expect(sent.first?.1["Token"] as? String == "r-1")
        #expect(sent.first?.1["ClientId"] as? String == "appclient123")
    }
}

/// Fails every request as if the device were offline.
final class OfflineStub: URLProtocol, @unchecked Sendable {
    override static func canInit(with _: URLRequest) -> Bool {
        true
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
}
