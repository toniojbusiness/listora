import Foundation
import ListoraAPI
import OpenAPIRuntime

/// A request that did not succeed: the server's `ErrorResponse`, or a failure to reach the server
/// or read its answer. ``message`` is always safe to show the user.
public struct APIFailure: Error, Equatable, Sendable {
    /// The HTTP status, or nil when no response arrived.
    public let statusCode: Int?
    /// The contract's `error.code` (open: compare with ``knownCode``), or a client-side code:
    /// `network_unavailable` or `invalid_response`.
    public let code: String
    public let message: String
    /// True when the same request may succeed later without changes.
    public let retryable: Bool
    public let retryAfter: Duration?
    /// The server's request id, for support.
    public let requestID: String?

    public init(
        statusCode: Int?,
        code: String,
        message: String,
        retryable: Bool,
        retryAfter: Duration? = nil,
        requestID: String? = nil,
    ) {
        self.statusCode = statusCode
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retryAfter = retryAfter
        self.requestID = requestID
    }

    /// The server's error body for an HTTP status.
    public init(statusCode: Int, response: some ErrorResponseCarrying) {
        let error = response.errorResponse.error
        self.init(
            statusCode: statusCode,
            code: error.code.value1?.rawValue ?? error.code.value2 ?? "unknown",
            message: error.message,
            retryable: error.retryable,
            retryAfter: error.retryAfterSeconds.map { .seconds(Int($0)) },
            requestID: error.requestId,
        )
    }

    /// A request that threw instead of returning a response.
    public init(_ error: any Error) {
        let underlying = (error as? ClientError)?.underlyingError ?? error
        if let failure = underlying as? APIFailure {
            self = failure
        } else if underlying is URLError {
            self = .networkUnavailable
        } else {
            self.init(
                statusCode: nil,
                code: "invalid_response",
                message: "Listora sent an answer this version of the app cannot read.",
                retryable: true,
            )
        }
    }

    /// No connection, a timeout, or a dropped connection.
    public static let networkUnavailable = APIFailure(
        statusCode: nil,
        code: "network_unavailable",
        message: "Can't reach Listora. Check your connection.",
        retryable: true,
    )

    public var knownCode: Components.Schemas.KnownErrorCode? {
        Components.Schemas.KnownErrorCode(rawValue: code)
    }

    /// The server did not accept the session's token: the user has to sign in again.
    public var isUnauthenticated: Bool {
        statusCode == 401
    }
}

/// A generated error response whose body is the contract's `ErrorResponse`.
public protocol ErrorResponseCarrying {
    var errorResponse: Components.Schemas.ErrorResponse { get }
}

extension Components.Responses.DefaultError: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}

extension Components.Responses.BadRequest: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}

extension Components.Responses.NotFound: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}

extension Components.Responses.Conflict: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}

extension Components.Responses.ValidationFailed: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}

extension Components.Responses.PayloadTooLarge: ErrorResponseCarrying {
    public var errorResponse: Components.Schemas.ErrorResponse {
        switch body {
        case let .json(response): response
        }
    }
}
