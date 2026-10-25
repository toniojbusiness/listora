import AVFoundation
import Core
import os
import Speech

/// ``VoiceTranscriber`` with Apple's Speech framework: the microphone through `AVAudioEngine`
/// into an `SFSpeechRecognizer` for the seller's language. Recognition runs on the device when
/// the device supports it for that language (no network, no cost); otherwise Apple's
/// recognition service does it. Either way only the text reaches Listora.
@MainActor
public final class AppleSpeechTranscriber: VoiceTranscriber {
    /// How long ``finish()`` waits for the recognizer's final transcript after the audio ends
    /// before it settles for the last partial one.
    static let finalResultTimeout: Duration = .seconds(2)

    private let locale: Locale
    private let log = Logger(subsystem: "com.listora.app", category: "voice")
    private var session: RecognitionSession?

    public init(locale: Locale = .current) {
        self.locale = locale
    }

    public var authorization: SpeechAuthorization {
        Self.authorization(
            speech: SFSpeechRecognizer.authorizationStatus(),
            microphone: AVAudioApplication.shared.recordPermission,
            recognizerAvailable: recognizer() != nil,
        )
    }

    public func requestAuthorization() async -> SpeechAuthorization {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            _ = await Self.requestSpeechAuthorization()
        }
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        return authorization
    }

    public func start(onPartial: @escaping @MainActor (String) -> Void) throws(SpeechTranscriptionError) {
        cancel()
        guard authorization == .authorized else { throw .notAuthorized }
        guard let recognizer = recognizer(), recognizer.isAvailable else { throw .unavailable }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        // Free and private when the device can; Apple's service otherwise.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let session = RecognitionSession(request: request, onPartial: onPartial)
        do {
            try session.startAudio()
        } catch {
            session.stopAudio()
            log.error("Voice: the microphone did not start: \(String(describing: error), privacy: .public)")
            throw .audio(String(describing: error))
        }
        session.task = recognizer.recognitionTask(with: request, resultHandler: Self.resultHandler(for: session))
        self.session = session
    }

    public func finish() async throws(SpeechTranscriptionError) -> String {
        guard let session else { return "" }
        self.session = nil
        session.stopAudio()
        session.request.endAudio()
        let transcript = await session.finalTranscript(timeout: Self.finalResultTimeout)
        session.task?.cancel()
        if transcript.isEmpty, let failure = session.failure {
            log.error("Voice: recognition failed: \(failure, privacy: .public)")
            throw .recognition(failure)
        }
        return transcript
    }

    public func cancel() {
        guard let session else { return }
        self.session = nil
        session.stopAudio()
        session.task?.cancel()
        session.settle()
    }

    private func recognizer() -> SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
    }

    static func authorization(
        speech: SFSpeechRecognizerAuthorizationStatus,
        microphone: AVAudioApplication.recordPermission,
        recognizerAvailable: Bool,
    ) -> SpeechAuthorization {
        guard recognizerAvailable else { return .unavailable }
        switch speech {
        case .denied: return .speechDenied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        case .authorized: break
        @unknown default: return .restricted
        }
        switch microphone {
        case .denied: return .microphoneDenied
        case .undetermined: return .notDetermined
        case .granted: return .authorized
        @unknown default: return .microphoneDenied
        }
    }

    /// Made outside the main actor: the recognizer calls it on its own queue.
    nonisolated private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }

    /// Made outside the main actor: the recognizer calls it on its own queue. It reads the
    /// strings out there and hands only them to the main actor.
    nonisolated private static func resultHandler(for session: RecognitionSession)
        -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void
    {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failure = error.map { String(describing: $0) }
            Task { @MainActor in
                session.receive(text: text, isFinal: isFinal, failure: failure)
            }
        }
    }
}

/// One hold of the talk button: the audio engine feeding the recognition request, the
/// transcript so far, and the wait for the final one.
@MainActor
private final class RecognitionSession {
    let request: SFSpeechAudioBufferRecognitionRequest
    let onPartial: @MainActor (String) -> Void
    var task: SFSpeechRecognitionTask?
    private(set) var transcript = ""
    private(set) var failure: String?
    private let engine = AVAudioEngine()
    private var waiting: CheckedContinuation<String, Never>?
    private var isSettled = false

    init(request: SFSpeechAudioBufferRecognitionRequest, onPartial: @escaping @MainActor (String) -> Void) {
        self.request = request
        self.onPartial = onPartial
    }

    func startAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audio.setActive(true, options: .notifyOthersOnDeactivation)
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.tap(request))
        engine.prepare()
        try engine.start()
    }

    func stopAudio() {
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func receive(text: String?, isFinal: Bool, failure: String?) {
        guard !isSettled else { return }
        if let text, text != transcript {
            transcript = text
            onPartial(text)
        }
        if let failure {
            self.failure = failure
        }
        if isFinal || failure != nil {
            settle()
        }
    }

    /// The final transcript once the recognizer has it, or the latest one after `timeout`.
    func finalTranscript(timeout: Duration) async -> String {
        if isSettled {
            return transcript
        }
        return await withCheckedContinuation { continuation in
            waiting = continuation
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                self?.settle()
            }
        }
    }

    func settle() {
        isSettled = true
        waiting?.resume(returning: transcript)
        waiting = nil
    }

    /// Made outside the main actor: the audio engine calls it on its render thread. Appending
    /// buffers from that thread is how the Speech framework is meant to be fed.
    nonisolated private static func tap(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        nonisolated(unsafe) let request = request
        return { buffer, _ in request.append(buffer) }
    }
}
