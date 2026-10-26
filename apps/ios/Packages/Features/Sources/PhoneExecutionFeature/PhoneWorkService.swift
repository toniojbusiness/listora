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
    /// `nil` once the run is over.
    public let call: Call?
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
    /// Claims the next work waiting for this device; `nil` when there is none.
    func claim(installationID: String, runtimeVersion: Int) async throws(APIFailure) -> PhoneRun?
    /// Answers the run's call; the run's next call, or `nil` once it is over.
    func answer(
        runID: String,
        index: Int,
        answer: Data,
        installationID: String,
    ) async throws(APIFailure) -> PhoneRun?
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

    public func claim(installationID: String, runtimeVersion: Int) async throws(APIFailure) -> PhoneRun? {
        let output = try await call {
            try await api.client.claimPhoneRun(
                headers: .init(idempotencyKey: UUID().uuidString),
                body: .json(.init(installationId: installationID, runtimeVersion: Int32(runtimeVersion))),
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
            call: call,
        )
    }
}
