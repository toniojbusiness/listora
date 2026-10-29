import APIClient
import Foundation
import ListoraAPI

/// A phone run as the server hands it out: the work, and the script call to run next.
public struct PhoneRun: Equatable, Sendable {
    public struct Call: Equatable, Sendable {
        public let index: Int
        /// The call for the phone runtime (`listoraPhone.run`), JSON as the server sent it.
        public let input: Data
    }

    public let id: String
    public let purpose: String
    public let marketplace: String
    /// The listing change the run is for; `nil` for a sign-in or sale check.
    public let operationID: String?
    /// `nil` once the run is over.
    public let call: Call?

    public init(id: String, purpose: String, marketplace: String, operationID: String? = nil, call: Call?) {
        self.id = id
        self.purpose = purpose
        self.marketplace = marketplace
        self.operationID = operationID
        self.call = call
    }
}

/// What a claim found: the run to start, or nothing, and then when to ask again.
public struct PhoneClaim: Equatable, Sendable {
    /// The run to start; `nil` when nothing waits for this phone now.
    public let run: PhoneRun?
    /// With nothing to run: how long the app waits, while it is open, before it asks again
    /// (sooner when work for this phone is due then); `nil` when Listora didn't say.
    public let nextClaimIn: Duration?

    public init(run: PhoneRun?, nextClaimIn: Duration? = nil) {
        self.run = run
        self.nextClaimIn = nextClaimIn
    }
}

/// This device, as it registers with Listora.
public struct DeviceRegistration: Equatable, Sendable {
    public var name: String
    public var appVersion: String
    public var runtimeVersion: Int
    /// The APNs token, hex, when the app has one.
    public var pushToken: String?
    /// `sandbox` or `production`.
    public var pushEnvironment: String?
}

/// The API calls of phone runs (docs/features/phone-execution.md).
public protocol PhoneWorkService: Sendable {
    func register(installationID: String, _ device: DeviceRegistration) async throws(APIFailure)
    /// Claims the next work waiting for this device, or says when to ask again. `running`: the
    /// runs this phone still runs (one per marketplace, side by side), so the server gives no
    /// second run on their marketplaces and recovers any other run it holds for this device.
    /// `appOpen`: the seller has the app open, so waiting changes run without their backoff.
    func claim(
        installationID: String,
        runtimeVersion: Int,
        running: [String],
        appOpen: Bool,
    ) async throws(APIFailure) -> PhoneClaim
    /// While the app is open: returns as soon as work for this device may be ready to claim
    /// (`true`), or once `upTo` passed with none (`false`). It claims nothing; the app claims
    /// after it.
    func waitForWork(installationID: String, upTo: Duration) async throws(APIFailure) -> Bool
    /// The runtime the server runs with (`have`: the digest the app already runs).
    func runtime(have: String?) async throws(APIFailure) -> RemoteRuntime
    /// Answers the run's call; the run's next call, or `nil` once it is over.
    func answer(
        runID: String,
        index: Int,
        answer: Data,
        installationID: String,
    ) async throws(APIFailure) -> PhoneRun?
}

extension PhoneWorkService {
    /// A service without waits: the runner looks again on its own timer instead.
    public func waitForWork(installationID _: String, upTo _: Duration) async throws(APIFailure) -> Bool {
        throw APIFailure(
            statusCode: 404, code: "not_found", message: "Listora can't wait for work here.", retryable: false,
        )
    }
}

public struct APIPhoneWorkService: PhoneWorkService {
    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func register(installationID: String, _ device: DeviceRegistration) async throws(APIFailure) {
        let body = Components.Schemas.DeviceRegistration(
            name: device.name,
            platform: .ios,
            appVersion: device.appVersion,
            runtimeVersion: Int32(device.runtimeVersion),
            pushToken: device.pushToken,
            pushEnvironment: device.pushEnvironment.flatMap(Components.Schemas.PushEnvironment.init(rawValue:)),
        )
        let output = try await call {
            try await api.client.registerDevice(path: .init(installationId: installationID), body: .json(body))
        }
        switch output {
        case .ok:
            return
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func claim(
        installationID: String,
        runtimeVersion: Int,
        running: [String],
        appOpen: Bool,
    ) async throws(APIFailure) -> PhoneClaim {
        let body = Components.Schemas.PhoneRunClaim(
            installationId: installationID,
            runtimeVersion: Int32(runtimeVersion),
            running: running.isEmpty ? nil : running,
            appOpen: appOpen,
        )
        let output = try await call {
            try await api.client.claimPhoneRun(
                headers: .init(idempotencyKey: UUID().uuidString),
                body: .json(body),
            )
        }
        switch output {
        case let .ok(response):
            let result = try decode { try response.body.json }
            return try PhoneClaim(
                run: PhoneRun(result.run),
                nextClaimIn: result.nextClaimInSeconds.map { .seconds(Int($0)) },
            )
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func waitForWork(installationID: String, upTo: Duration) async throws(APIFailure) -> Bool {
        let query = Operations.WaitForPhoneWork.Input.Query(
            installationId: installationID,
            waitSeconds: Int32(max(1, min(20, upTo.components.seconds))),
        )
        let output = try await call {
            try await api.client.waitForPhoneWork(query: query)
        }
        switch output {
        case let .ok(response):
            return try decode { try response.body.json }.ready
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func runtime(have: String?) async throws(APIFailure) -> RemoteRuntime {
        let output = try await call {
            try await api.client.getPhoneRuntime(query: .init(have: have))
        }
        switch output {
        case let .ok(response):
            let body = try decode { try response.body.json }
            return RemoteRuntime(
                digest: body.digest,
                source: body.source,
                runtimeVersion: Int(body.runtimeVersion),
                signature: body.signature,
            )
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func answer(
        runID: String,
        index: Int,
        answer: Data,
        installationID: String,
    ) async throws(APIFailure) -> PhoneRun? {
        let payload = try decode {
            try JSONDecoder().decode(Components.Schemas.PhoneCallAnswer.AnswerPayload.self, from: answer)
        }
        let output = try await call {
            try await api.client.answerPhoneCall(
                path: .init(runId: runID, index: String(index)),
                body: .json(.init(installationId: installationID, answer: payload)),
            )
        }
        switch output {
        case let .ok(response):
            return try PhoneRun(decode { try response.body.json }.run)
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    private func call<Output>(_ body: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await body()
        } catch {
            throw APIFailure(error)
        }
    }

    private func decode<Value>(_ body: () throws -> Value) throws(APIFailure) -> Value {
        do {
            return try body()
        } catch {
            throw APIFailure(error)
        }
    }
}

extension PhoneRun {
    init?(_ run: Components.Schemas.PhoneRun?) throws(APIFailure) {
        guard let run else { return nil }
        var call: Call?
        if let given = run.call {
            do {
                call = try Call(index: Int(given.index), input: JSONEncoder().encode(given.input))
            } catch {
                throw APIFailure(error)
            }
        }
        self.init(
            id: run.id,
            purpose: run.purpose.value1?.rawValue ?? run.purpose.value2 ?? "",
            marketplace: run.marketplace.value1?.rawValue ?? run.marketplace.value2 ?? "",
            operationID: run.operationId,
            call: call,
        )
    }
}
