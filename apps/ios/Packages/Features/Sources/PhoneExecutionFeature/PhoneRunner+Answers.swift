import Foundation

extension PhoneRunner {
    /// Answers a call, trying again a few times while Listora can't be reached (the answer is
    /// idempotent); `nil` when the run is over, or the answer could not be sent.
    func send(
        _ answer: Data,
        for call: PhoneRun.Call,
        of run: PhoneRun,
        installationID: String,
    ) async -> PhoneRun? {
        for attempt in 1 ... 3 {
            do {
                let next = try await service.answer(
                    runID: run.id,
                    index: call.index,
                    answer: answer,
                    installationID: installationID,
                )
                runProblem = nil
                return next
            } catch {
                let unreachable = error.statusCode == nil || (error.statusCode ?? 0) >= 500
                guard unreachable, attempt < 3 else {
                    if !unreachable {
                        // The run is over (404) or moved on (409): claim the next.
                        return nil
                    }
                    runProblem = error.message
                    return nil
                }
                try? await sleep(.seconds(attempt * 2))
            }
        }
        return nil
    }

    /// The answer for a call the phone could not run (docs/features/phone-execution.md, "Lapsed
    /// runs"): what went wrong, for the server's log.
    static func notRun(_ error: any Error) -> Data {
        let reason = String(String(describing: error).prefix(200))
        // A dictionary of strings always serializes.
        return (try? JSONSerialization.data(withJSONObject: ["type": "not_run", "message": reason])) ?? Data()
    }
}
