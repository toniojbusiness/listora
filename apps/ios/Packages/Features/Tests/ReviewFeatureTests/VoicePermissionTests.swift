import APIClient
import Core
import Foundation
import Testing
@testable import ReviewFeature

/// Voice permissions, their fallbacks to typing, and recognition failing.
@MainActor
struct VoicePermissionTests {
    let harness = ReviewFlowHarness()
    let transcriber = FakeTranscriber()

    private func review() async -> (ReviewFlowModel, VoiceCorrectionModel) {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        return (model, VoiceCorrectionModel(target: model, transcriber: transcriber))
    }

    private func say(_ text: String, to voice: VoiceCorrectionModel) async {
        voice.pressBegan()
        transcriber.say(text)
        await voice.pressEnded()
    }

    @Test
    func `asks for permission with an explanation before the first listen`() async {
        let (_, voice) = await review()
        transcriber.authorization = .notDetermined
        voice.pressBegan()
        #expect(voice.phase == .idle)
        #expect(voice.notice?.action == .allowVoice)
        #expect(!transcriber.isListening)

        await voice.allowVoice()
        #expect(voice.notice?.message == "Voice is on. Hold the mic while you talk.")
        voice.pressBegan()
        #expect(voice.isListening)
    }

    @Test
    func `denied permission says where to turn it on and offers typing instead`() async {
        let (model, voice) = await review()
        transcriber.authorization = .notDetermined
        transcriber.grants = .microphoneDenied
        voice.pressBegan()
        await voice.allowVoice()
        #expect(voice.notice == .init(
            message: "Listora can't use the microphone. Turn it on in Settings, or type your correction.",
            tone: .warning,
            action: .openSettings,
        ))
        #expect(voice.showsTyping)

        voice.typed = "brand Pendleton"
        await voice.submitTyped()
        #expect(voice.typed.isEmpty)
        #expect(voice.proposals.map(\.change) == [.set(.brand, .text("Pendleton"))])
        voice.acceptAll()
        #expect(model.form?.field(.brand).provenance == .user)
    }

    @Test(arguments: [
        (SpeechAuthorization.speechDenied, VoiceNotice.Action?.some(.openSettings)),
        (.restricted, nil),
        (.unavailable, nil),
    ])
    func `voice that is off or unavailable falls back to typing`(
        authorization: SpeechAuthorization,
        action: VoiceNotice.Action?,
    ) async {
        let (_, voice) = await review()
        transcriber.authorization = authorization
        voice.pressBegan()
        #expect(!voice.isListening)
        #expect(voice.notice?.action == action)
        #expect(voice.showsTyping)
    }

    @Test
    func `a failed recognition says so and nothing is proposed`() async {
        let (_, voice) = await review()
        transcriber.finishFailure = .recognition("no speech")
        await say("size large", to: voice)
        #expect(voice.proposals.isEmpty)
        #expect(voice.notice?.message == "Listora couldn't make that out. Hold the mic and try again, or type it.")
    }

    @Test
    func `leaving while listening drops what was heard`() async {
        let (_, voice) = await review()
        voice.pressBegan()
        transcriber.say("size large")
        voice.cancelListening()
        #expect(voice.phase == .idle)
        #expect(transcriber.cancels == 1)
        await voice.pressEnded()
        #expect(voice.proposals.isEmpty)
    }
}
