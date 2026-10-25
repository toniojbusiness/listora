import APIClient
import ListoraAPI

/// What the seller sees when the flow stops: the server's failures and the flow's own.
extension ReviewFlowModel {
    static func problem(_ failure: APIFailure) -> Problem {
        let title = switch failure.knownCode {
        case .quotaExceeded: "Your plan's limit is reached"
        case .notFound: "This item isn't on Listora anymore"
        default: "Something went wrong"
        }
        return Problem(
            title: title,
            message: failure.message,
            canRetry: failure.retryable || failure.statusCode == nil,
            suggestsEditingPhotos: false,
        )
    }

    static func problem(analysisFailure failure: Components.Schemas.AnalysisFailure?) -> Problem {
        guard let failure else {
            return Problem(
                title: "Listora couldn't analyze this item",
                message: "The analysis stopped without a reason. Try again.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        }
        return Problem(
            title: "Listora couldn't analyze this item",
            message: failure.message,
            canRetry: failure.retryable,
            suggestsEditingPhotos: !failure.retryable,
        )
    }
}

/// Why the flow stopped, before it becomes a ``ReviewFlowModel/Problem``.
enum ReviewFlowError: Error, Equatable {
    enum Stage: Equatable {
        case photos
        case analysis
    }

    case photoFailed(reason: String?)
    case timedOut(Stage)

    var problem: ReviewFlowModel.Problem {
        switch self {
        case let .photoFailed(reason):
            ReviewFlowModel.Problem(
                title: "A photo couldn't be processed",
                message: [reason, "Remove or replace that photo, then review the item again."]
                    .compactMap(\.self).joined(separator: " "),
                canRetry: false,
                suggestsEditingPhotos: true,
            )
        case .timedOut(.photos):
            ReviewFlowModel.Problem(
                title: "Your photos are taking longer than usual",
                message: "Listora is still getting them ready. Try again in a moment.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        case .timedOut(.analysis):
            ReviewFlowModel.Problem(
                title: "The analysis is taking longer than usual",
                message: "It keeps running on Listora. Try again in a moment to see the result.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        }
    }
}
