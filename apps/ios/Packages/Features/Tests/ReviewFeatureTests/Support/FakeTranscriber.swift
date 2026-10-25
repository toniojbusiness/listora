import Core
@testable import ReviewFeature

/// A microphone that "hears" what the test says, with permissions the test sets.
@MainActor
final class FakeTranscriber: VoiceTranscriber {
    var authorization: SpeechAuthorization
    /// What asking for permission ends in.
    var grants: SpeechAuthorization = .authorized
    var heard = ""
    var startFailure: SpeechTranscriptionError?
    var finishFailure: SpeechTranscriptionError?
    private(set) var isListening = false
    private(set) var cancels = 0
    private var onPartial: (@MainActor (String) -> Void)?

    init(authorization: SpeechAuthorization = .authorized) {
        self.authorization = authorization
    }

    func requestAuthorization() async -> SpeechAuthorization {
        authorization = grants
        return authorization
    }

    func start(onPartial: @escaping @MainActor (String) -> Void) throws(SpeechTranscriptionError) {
        if let startFailure {
            throw startFailure
        }
        isListening = true
        self.onPartial = onPartial
    }

    /// The seller says some more while holding the button.
    func say(_ text: String) {
        heard = text
        onPartial?(text)
    }

    func finish() async throws(SpeechTranscriptionError) -> String {
        isListening = false
        if let finishFailure {
            throw finishFailure
        }
        return heard
    }

    func cancel() {
        isListening = false
        cancels += 1
    }
}
