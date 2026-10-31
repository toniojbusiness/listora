import Core
import Foundation
import Observation
import os

/// The scan camera's microphone: hold it and say something about the item ("medium, small
/// stain"), let go to add it as the scan's note. Speech is turned into text on this iPhone; only
/// the text is sent with the scan.
@MainActor
@Observable
final class ScanVoice {
    private(set) var isListening = false
    /// What was heard so far while held.
    private(set) var heard = ""
    /// Why the microphone can't be used, in words for the seller.
    private(set) var notice: String?

    private let transcriber: (any VoiceTranscriber)?
    private let log = Logger(subsystem: "com.listora.app", category: "scan")

    init(transcriber: (any VoiceTranscriber)?) {
        self.transcriber = transcriber
    }

    var isAvailable: Bool {
        transcriber != nil
    }

    func pressBegan() {
        guard let transcriber, !isListening else { return }
        switch transcriber.authorization {
        case .authorized:
            break
        case .notDetermined:
            Task {
                let answer = await transcriber.requestAuthorization()
                notice = answer == .authorized ? "Now hold the mic and talk." : Self.unavailable(answer)
            }
            return
        default:
            notice = Self.unavailable(transcriber.authorization)
            return
        }
        do {
            try transcriber.start { [weak self] text in
                guard let self, isListening else { return }
                heard = text
            }
            notice = nil
            heard = ""
            isListening = true
        } catch {
            log.error("Scan note: listening did not start: \(String(describing: error), privacy: .public)")
            notice = Self.unavailable(.unavailable)
        }
    }

    /// The mic came up: the note heard, or nil when nothing was said.
    func pressEnded() async -> String? {
        guard let transcriber, isListening else { return nil }
        isListening = false
        defer { heard = "" }
        do {
            let text = try await transcriber.finish().trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            notice = "Listora couldn't make that out. Hold the mic and try again."
            return nil
        }
    }

    func cancel() {
        guard isListening else { return }
        isListening = false
        heard = ""
        transcriber?.cancel()
    }

    private static func unavailable(_ authorization: SpeechAuthorization) -> String {
        switch authorization {
        case .microphoneDenied: "Allow the microphone for Listora in Settings to add notes by voice."
        case .speechDenied: "Allow speech recognition for Listora in Settings to add notes by voice."
        case .restricted: "Notes by voice aren't allowed on this iPhone."
        case .unavailable, .notDetermined, .authorized: "Notes by voice aren't available right now."
        }
    }
}
