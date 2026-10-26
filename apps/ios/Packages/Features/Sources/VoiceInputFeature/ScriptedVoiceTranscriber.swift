import Core

/// A ``VoiceTranscriber`` that "hears" a fixed transcript, for UI tests and previews
/// (`LISTORA_VOICE_TRANSCRIPT`). The simulator has no voice to listen to, so the tests drive the
/// real talk button and this answers in place of the microphone.
@MainActor
public final class ScriptedVoiceTranscriber: VoiceTranscriber {
    private let transcript: String
    private var state: SpeechAuthorization
    private let granted: SpeechAuthorization
    private var isListening = false

    /// `authorization` is what asking for permission ends in (`LISTORA_VOICE_PERMISSION`).
    public init(transcript: String, authorization: SpeechAuthorization = .authorized) {
        self.transcript = transcript
        state = authorization == .authorized ? .notDetermined : authorization
        granted = authorization
    }

    public var authorization: SpeechAuthorization {
        state
    }

    public func requestAuthorization() async -> SpeechAuthorization {
        state = granted
        return state
    }

    public func start(onPartial: @escaping @MainActor (String) -> Void) throws(SpeechTranscriptionError) {
        guard state == .authorized else { throw .notAuthorized }
        isListening = true
        onPartial(transcript)
    }

    public func finish() async throws(SpeechTranscriptionError) -> String {
        guard isListening else { return "" }
        isListening = false
        return transcript
    }

    public func cancel() {
        isListening = false
    }
}
