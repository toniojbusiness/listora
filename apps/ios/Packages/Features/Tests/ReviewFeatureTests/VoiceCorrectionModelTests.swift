import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// Spoken corrections on the review: permissions, the on-device parse, the text model for what
/// it could not map, and accepting, dismissing, and undoing each proposed change.
@MainActor
struct VoiceCorrectionModelTests {
    let harness = ReviewFlowHarness()
    let transcriber = FakeTranscriber()

    /// The review of the fixture item (size M, colors red and black, brand at 0.45) with voice.
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

    private func voiceCalls() async -> [FakeReviewService.Call] {
        await harness.service.calls.filter {
            if case .voice = $0 {
                return true
            }
            return false
        }
    }

    // MARK: Proposing

    @Test
    func `proposes what was said, changes nothing until accepted, and costs no AI call`() async throws {
        let (model, voice) = await review()
        voice.pressBegan()
        #expect(voice.phase == .listening(""))
        transcriber.say("size large, small stain on the left cuff")
        #expect(voice.phase == .listening("size large, small stain on the left cuff"))
        transcriber.say("size large, small stain on the left cuff, paid four dollars at Goodwill")
        await voice.pressEnded()

        #expect(voice.phase == .idle)
        #expect(voice.heard == "size large, small stain on the left cuff, paid four dollars at Goodwill")
        #expect(voice.proposals.map(\.change) == [
            .set(.sizeLabel, .text("L")),
            .add(.flaws, "Small stain on the left cuff"),
            .cost(400),
            .purchaseSource("Goodwill"),
        ])
        #expect(voice.proposals.allSatisfy { !$0.fromAI && !$0.isApplied })
        #expect(voice.proposals.map(\.change.summary) == [
            "Size: L", "Flaws: + Small stain on the left cuff", "Paid: $4.00", "Bought at: Goodwill",
        ])
        // The size type is already letter, so only the label is proposed.
        let form = try #require(model.form)
        #expect(form.field(.sizeLabel).value == .text("M"))
        #expect(!form.hasEdits)
        #expect(model.cost.amount.isEmpty)
        #expect(await voiceCalls().isEmpty, "routine corrections never reach the AI")
    }

    @Test
    func `an accepted change is the seller's own edit, saved with the review`() async throws {
        let (model, voice) = await review()
        await say("colors navy, brand Acme, paid $3.50 at the bins, price at 30", to: voice)
        #expect(voice.proposals.count == 5)
        voice.acceptAll()
        #expect(voice.pendingCount == 0)

        let form = try #require(model.form)
        let colors = form.field(.colors)
        #expect(colors.value == .list(["navy"]))
        #expect(colors.provenance == .user)
        #expect(!colors.needsAttention, "the seller's value loses the highlight")
        #expect(form.field(.brand).provenance == .user)
        #expect(model.cost.amount.cents == 350)
        #expect(model.cost.source == "Bins")
        #expect(model.priceChoice == .custom(3000))

        await model.continueToCost()
        let saved = try #require(await harness.service.replacements.last)
        #expect(saved.details.colors == ["navy"])
        #expect(saved.details.brand == "Acme")
        #expect(model.showsCost)
    }

    @Test
    func `dismissing drops a proposal, and undo takes an accepted one back`() async throws {
        let (model, voice) = await review()
        await say("size large, small stain on the left cuff", to: voice)
        let size = try #require(voice.proposals.first)
        let flaw = try #require(voice.proposals.last)

        voice.dismiss(size.id)
        #expect(voice.proposals.map(\.change) == [.add(.flaws, "Small stain on the left cuff")])

        voice.accept(flaw.id)
        #expect(model.form?.field(.flaws).value == .list(["Small stain on the left cuff"]))
        #expect(model.form?.field(.flaws).provenance == .user)
        voice.undo(flaw.id)
        #expect(model.form?.field(.flaws).value == .list([]))
        #expect(voice.proposals.first?.isApplied == false, "offered again after undo")

        voice.close()
        #expect(voice.proposals.isEmpty)
        #expect(voice.heard == nil)
        #expect(model.form?.field(.flaws).value == .list([]), "closing applies nothing pending")
    }

    @Test
    func `undo puts back the value from before, even after another change to it`() async throws {
        let (model, voice) = await review()
        await say("size large", to: voice)
        voice.acceptAll()
        let first = try #require(voice.proposals.first)
        voice.accept(first.id)
        await say("size small", to: voice)
        let second = try #require(voice.proposals.last)
        voice.accept(second.id)
        #expect(model.form?.field(.sizeLabel).value == .text("S"))
        #expect(voice.proposals.count == 1, "the overwritten change can no longer be undone on its own")
        voice.undo(second.id)
        #expect(model.form?.field(.sizeLabel).value == .text("L"))
    }

    @Test
    func `a newer proposal for the same detail replaces a pending one`() async {
        let (_, voice) = await review()
        await say("size large", to: voice)
        await say("size small", to: voice)
        #expect(voice.proposals.map(\.change) == [.set(.sizeLabel, .text("S"))])
    }

    @Test
    func `says so when everything said is already set`() async {
        let (_, voice) = await review()
        await say("size medium, plaid", to: voice)
        #expect(voice.proposals.isEmpty)
        #expect(voice.notice?.message == "Those details are already set.")
    }

    @Test
    func `says so when nothing was heard`() async {
        let (_, voice) = await review()
        await say("", to: voice)
        #expect(voice.proposals.isEmpty)
        #expect(voice.notice?.message == "Listora didn't hear anything. Hold the mic while you talk.")
    }

    // MARK: The text model

    @Test
    func `sends only the phrases it could not map, as text, and proposes the answer`() async throws {
        let (model, voice) = await review()
        await harness.service.setVoiceAnswers([.success(.init(changes: [
            .init(field: .init(value1: .keywords, value2: "keywords"), value: "embroidered logo"),
            .init(field: .init(value1: .listPrice, value2: "listPrice"), amount: Fixtures.usd(2800)),
            .init(field: .init(value1: nil, value2: "era"), value: "1990s"),
        ]))])
        await say("size large, it has a tiny embroidered logo, um", to: voice)

        let calls = await voiceCalls()
        let call = try #require(calls.first)
        guard case let .voice(text, key) = call else { return }
        #expect(text == "it has a tiny embroidered logo")
        #expect(!key.isEmpty)
        #expect(calls.count == 1)
        #expect(voice.proposals.map(\.change) == [
            .set(.sizeLabel, .text("L")),
            .add(.keywords, "embroidered logo"),
            .listPrice(2800),
        ])
        #expect(voice.proposals.map(\.fromAI) == [false, true, true], "a field this app does not know is left out")
        #expect(voice.phase == .idle)
        #expect(model.form?.hasEdits == false)
    }

    @Test
    func `a failed interpretation keeps the rest and retries with the same key`() async throws {
        let (_, voice) = await review()
        await harness.service.setVoiceAnswers([
            .failure(.server(
                503,
                "service_unavailable",
                "Listora couldn't work out that correction just now.",
                retryable: true,
            )),
            .success(.init(changes: [.init(field: .init(value1: .brand, value2: "brand"), value: "Pendleton")])),
        ])
        await say("size large, it's that wool brand from Oregon", to: voice)
        #expect(voice.proposals.map(\.change) == [.set(.sizeLabel, .text("L"))])
        let notice = try #require(voice.notice)
        #expect(notice.message.hasPrefix("Listora couldn't work out that correction just now."))
        #expect(notice.action == .retry)

        await voice.retry()
        #expect(voice.notice == nil)
        #expect(voice.proposals.map(\.change) == [.set(.sizeLabel, .text("L")), .set(.brand, .text("Pendleton"))])
        let keys = await voiceCalls().compactMap { call -> String? in
            if case let .voice(_, key) = call {
                return key
            }
            return nil
        }
        #expect(keys.count == 2)
        #expect(Set(keys).count == 1, "the retry replays instead of paying again")
    }

    @Test
    func `a refusal that asking again won't fix offers no retry`() async throws {
        let (_, voice) = await review()
        await harness.service.setVoiceAnswers([
            .failure(.server(403, "forbidden", "AI is turned off for this account.")),
        ])
        await say("it's that wool brand from Oregon", to: voice)
        let notice = try #require(voice.notice)
        #expect(notice.message == "AI is turned off for this account.")
        #expect(notice.action == nil)
    }

    @Test
    func `says when the text model could not match anything`() async {
        let (_, voice) = await review()
        await say("hmm the vibe is very cottagecore", to: voice)
        #expect(voice.proposals.isEmpty)
        #expect(voice.notice?
            .message == "Listora couldn't match \"hmm the vibe is very cottagecore\" to a detail. Edit it by hand.")
    }
}

/// Common values on touch and hold, and "Next to check".
@MainActor
struct FastCorrectionTests {
    let harness = ReviewFlowHarness()

    private func review() async -> ReviewFlowModel {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        return model
    }

    @Test
    func `a common value is the seller's own edit`() async throws {
        let model = await review()
        let form = try #require(model.form)
        let navy = try #require(QuickValues.options(for: form.field(.colors)).first { $0.title == "Navy" })
        #expect(!navy.isCurrent)
        model.choose(navy)
        let colors = try #require(model.form?.field(.colors))
        #expect(colors.value == .list(["red", "black", "navy"]))
        #expect(colors.provenance == .user)

        // Choosing it again takes it off.
        let again = try #require(QuickValues.options(for: colors).first { $0.title == "Navy" })
        #expect(again.isCurrent)
        model.choose(again)
        #expect(model.form?.field(.colors).value == .list(["red", "black"]))
    }

    @Test
    func `sizes set the label and the letter size type; flaws are added`() async throws {
        let model = await review()
        let sizes = try QuickValues.options(for: #require(model.form?.field(.sizeLabel)))
        #expect(sizes.map(\.title) == ["XS", "S", "M", "L", "XL", "XXL", "One size"])
        #expect(sizes.first { $0.isCurrent }?.title == "M")
        try model.choose(#require(sizes.last))
        #expect(model.form?.field(.sizeLabel).value == .text("One size"))
        #expect(model.form?.field(.sizeSystem).value == .text("one_size"))

        let flaws = try QuickValues.options(for: #require(model.form?.field(.flaws)))
        #expect(flaws.first?.title == "No flaws")
        try model.choose(#require(flaws.first { $0.title == "Pilling" }))
        #expect(model.form?.field(.flaws).value == .list(["Pilling"]))
    }

    @Test
    func `free text and menu details offer no common values`() async throws {
        let model = await review()
        let form = try #require(model.form)
        #expect(QuickValues.options(for: form.field(.brand)).isEmpty)
        #expect(QuickValues.options(for: form.field(.condition)).isEmpty)
    }

    @Test
    func `next to check moves through the details that still need a look, wrapping around`() async {
        let model = await review()
        #expect(model.fieldsToCheck == [.brand, .colors])
        model.advanceToNextCheck()
        #expect(model.focusedField == .brand)
        #expect(model.editing?.key == .brand, "a typed detail opens its editor")
        model.advanceToNextCheck()
        #expect(model.focusedField == .colors)
        #expect(model.editing?.key == .colors)
        model.advanceToNextCheck()
        #expect(model.focusedField == .brand, "wraps around")

        // Fixing the brand takes it off the list; the swipe from it goes to the colors.
        model.editing?.text = "Acme"
        model.advanceToNextCheck(after: .brand)
        #expect(model.form?.field(.brand).provenance == .user)
        #expect(model.fieldsToCheck == [.colors])
        #expect(model.focusedField == .colors)
    }

    @Test
    func `next to check stops when nothing needs a look`() async {
        let model = await review()
        model.update(.brand, to: .text("Acme"))
        model.update(.colors, to: .list(["navy"]))
        model.advanceToNextCheck()
        #expect(model.fieldsToCheck.isEmpty)
        #expect(model.focusedField == nil)
        #expect(model.editing == nil)
    }
}
