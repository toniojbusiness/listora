import AVFoundation
import Core
import Speech
import Testing
@testable import VoiceInputFeature

@MainActor
struct AppleSpeechAuthorizationTests {
    @Test
    func `both permissions granted is authorized`() {
        #expect(AppleSpeechTranscriber.authorization(
            speech: .authorized,
            microphone: .granted,
            recognizerAvailable: true,
        ) == .authorized)
    }

    @Test
    func `each permission says which one is off or still to ask`() {
        #expect(AppleSpeechTranscriber.authorization(
            speech: .denied, microphone: .granted, recognizerAvailable: true,
        ) == .speechDenied)
        #expect(AppleSpeechTranscriber.authorization(
            speech: .authorized, microphone: .denied, recognizerAvailable: true,
        ) == .microphoneDenied)
        #expect(AppleSpeechTranscriber.authorization(
            speech: .restricted, microphone: .granted, recognizerAvailable: true,
        ) == .restricted)
        #expect(AppleSpeechTranscriber.authorization(
            speech: .notDetermined, microphone: .granted, recognizerAvailable: true,
        ) == .notDetermined)
        #expect(AppleSpeechTranscriber.authorization(
            speech: .authorized, microphone: .undetermined, recognizerAvailable: true,
        ) == .notDetermined)
    }

    @Test
    func `no recognizer for the language is unavailable, whatever the permissions`() {
        #expect(AppleSpeechTranscriber.authorization(
            speech: .authorized, microphone: .granted, recognizerAvailable: false,
        ) == .unavailable)
    }
}

@MainActor
struct ScriptedVoiceTranscriberTests {
    @Test
    func `hears its transcript once permission is granted`() async throws {
        let transcriber = ScriptedVoiceTranscriber(transcript: "size medium")
        #expect(transcriber.authorization == .notDetermined)
        #expect(throws: SpeechTranscriptionError.notAuthorized) { try transcriber.start { _ in } }
        #expect(await transcriber.requestAuthorization() == .authorized)
        var partials: [String] = []
        try transcriber.start { partials.append($0) }
        #expect(try await transcriber.finish() == "size medium")
        #expect(partials == ["size medium"])
        // Nothing is heard without holding the button again.
        #expect(try await transcriber.finish().isEmpty)
    }

    @Test
    func `a denied permission stays denied`() async {
        let transcriber = ScriptedVoiceTranscriber(transcript: "size medium", authorization: .microphoneDenied)
        #expect(transcriber.authorization == .microphoneDenied)
        #expect(await transcriber.requestAuthorization() == .microphoneDenied)
    }
}
