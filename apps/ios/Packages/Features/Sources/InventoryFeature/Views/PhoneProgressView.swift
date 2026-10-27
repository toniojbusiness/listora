import Core
import DesignSystem
import SwiftUI

/// The listing change this iPhone works on now: the step in plain words, its number, and about
/// how long the run has left (from the same work's earlier runs here), counting down.
struct PhoneProgressView: View {
    let progress: PhoneWorkProgress
    let marketplace: String

    var body: some View {
        StepProgressView(
            step: progress.step ?? "Starting",
            stepText: progress.stepText,
            fraction: progress.fractionDone,
            identifier: "marketplace.\(marketplace).progress",
        ) { now in
            progress.timeLeftText(at: now)
        }
    }
}
