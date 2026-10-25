import Foundation

/// Turns what the seller says into text while they hold a talk button, on the device.
///
/// `VoiceInputFeature` provides the Speech framework implementation; `AppFeature` injects it, so
/// a feature that takes spoken corrections depends only on this protocol. Audio never leaves
/// the device for Listora: only the text is used.
@MainActor
public protocol VoiceTranscriber: AnyObject {
    /// Where the microphone and speech recognition permissions stand, without asking.
    var authorization: SpeechAuthorization { get }
    /// Asks for each permission that is not decided yet (the system shows its prompts), then
    /// answers where they stand.
    func requestAuthorization() async -> SpeechAuthorization
    /// Starts listening. `onPartial` receives the transcript so far each time it grows.
    func start(onPartial: @escaping @MainActor (String) -> Void) throws(SpeechTranscriptionError)
    /// Stops listening and answers the final transcript, empty when nothing was said.
    func finish() async throws(SpeechTranscriptionError) -> String
    /// Stops listening and drops what was heard.
    func cancel()
}

/// Whether the seller can talk to Listora, and if not, why.
public enum SpeechAuthorization: Equatable, Sendable {
    /// One of the permissions has not been asked for yet.
    case notDetermined
    case authorized
    /// The seller turned off microphone access for Listora.
    case microphoneDenied
    /// The seller turned off speech recognition for Listora.
    case speechDenied
    /// A device policy (Screen Time, a profile) does not allow it.
    case restricted
    /// This device has no speech recognition for the seller's language.
    case unavailable
}

public enum SpeechTranscriptionError: Error, Equatable, Sendable {
    case notAuthorized
    case unavailable
    /// The microphone could not start; the description is the system's, for the log.
    case audio(String)
    /// Recognition failed; the description is the system's, for the log.
    case recognition(String)
}
