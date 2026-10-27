import Core
import Foundation

/// The progress of the work running now (`progress`), from the steps the runtime reports.
extension PhoneRunner {
    /// The run whose calls start now: its marketplace's progress starts over unless it is the
    /// same work.
    func track(_ run: PhoneRun) {
        if let shown = progressByMarketplace[run.marketplace], shown.operationID == run.operationID {
            return
        }
        progressByMarketplace[run.marketplace] = PhoneWorkProgress(
            marketplace: run.marketplace,
            operationID: run.operationID,
            step: nil,
            stepNumber: 0,
            stepCount: nil,
            expectedEnd: nil,
        )
    }

    /// The runtime started a step of a marketplace's call running now.
    func stepStarted(_ step: PhoneStep) {
        guard let shown = progressByMarketplace[step.marketplace] else { return }
        progressByMarketplace[step.marketplace] = timings.started(step, operationID: shown.operationID)
    }

    /// Whether the runtime's answer says the script ran all its steps (`result.ok`).
    static func ranToTheEnd(_ answer: Data) -> Bool {
        let output = try? JSONSerialization.jsonObject(with: answer) as? [String: Any]
        return (output?["result"] as? [String: Any])?["ok"] as? Bool ?? false
    }
}
