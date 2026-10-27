import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ImportFeature

/// A stand-in for the API, recording what the screen sent.
actor FakeImportsService: ImportsService {
    var marketplacesAnswers: [[Components.Schemas.ListingImportMarketplace]] = []
    var startAnswers: [Result<Components.Schemas.ListingImport, APIFailure>] = []
    var questionsAnswer: [Components.Schemas.ListingImportQuestion] = []
    var answerResults: [Result<Components.Schemas.ListingImport, APIFailure>] = []
    private(set) var startKeys: [String] = []
    struct SentAnswer {
        let questionID: String
        let answer: Components.Schemas.ListingImportAnswer
        let key: String
    }

    private(set) var answers: [SentAnswer] = []
    private(set) var marketplaceReads = 0

    func set(marketplaces: [[Components.Schemas.ListingImportMarketplace]]) {
        marketplacesAnswers = marketplaces
    }

    func set(start: [Result<Components.Schemas.ListingImport, APIFailure>]) {
        startAnswers = start
    }

    func set(
        questions: [Components.Schemas.ListingImportQuestion],
        answers: [Result<Components.Schemas.ListingImport, APIFailure>],
    ) {
        questionsAnswer = questions
        answerResults = answers
    }

    func marketplaces() async throws(APIFailure) -> [Components.Schemas.ListingImportMarketplace] {
        marketplaceReads += 1
        return marketplacesAnswers.count > 1 ? marketplacesAnswers.removeFirst() : marketplacesAnswers.first ?? []
    }

    func start(
        marketplace _: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport {
        startKeys.append(idempotencyKey)
        return try startAnswers.removeFirst().get()
    }

    func questions(importID _: String) async throws(APIFailure) -> [Components.Schemas.ListingImportQuestion] {
        questionsAnswer
    }

    func answer(
        importID _: String,
        questionID: String,
        answer: Components.Schemas.ListingImportAnswer,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport {
        answers.append(SentAnswer(questionID: questionID, answer: answer, key: idempotencyKey))
        return try answerResults.removeFirst().get()
    }
}

@MainActor
final class RecordingPhoneWork: PhoneWorkTrigger {
    private(set) var reasons: [PhoneWorkReason] = []

    func runPhoneWork(_ reason: PhoneWorkReason) {
        reasons.append(reason)
    }
}

enum ImportFixtures {
    static func listingImport(
        status: Components.Schemas.KnownListingImportStatus = .finished,
        progress: String = "Done",
        summary: String? = "Imported 42 from Depop, 3 need you",
        needsYou: Int32 = 3,
        stoppedReason: String? = nil,
    ) -> Components.Schemas.ListingImport {
        .init(
            id: "0199a1f0-0000-7000-8000-00000000e001",
            marketplace: .init(value1: .depop),
            status: .init(value1: status),
            runsOn: .init(value1: .phone),
            counts: .init(read: 45, imported: 40, merged: 2, alreadyListed: 0, needsYou: needsYou, failed: 0),
            progress: progress,
            summary: summary,
            stoppedReason: stoppedReason,
            startedAt: Date(timeIntervalSince1970: 1_761_000_000),
        )
    }

    static func marketplace(
        _ known: Components.Schemas.KnownMarketplace,
        canStart: Bool = true,
        reason: String? = nil,
        latest: Components.Schemas.ListingImport? = nil,
    ) -> Components.Schemas.ListingImportMarketplace {
        .init(marketplace: .init(value1: known), canStart: canStart, unavailableReason: reason, latest: latest)
    }

    static func question(id: String = "q-1") -> Components.Schemas.ListingImportQuestion {
        .init(
            id: id,
            marketplace: .init(value1: .mercari),
            externalListingId: "m123",
            title: "Summer sundress",
            candidates: [.init(
                itemId: "item-1",
                sku: "AJ-000001",
                title: "Floral maxi dress",
                reason: .init(value1: .photo),
                why: "A photo looks the same",
            )],
        )
    }
}

@MainActor
@Suite("Import listings")
struct ImportsModelTests {
    @Test
    func `shows each marketplace in the server's words, and why one can't start`() async {
        let service = FakeImportsService()
        await service.set(marketplaces: [[
            ImportFixtures.marketplace(.depop, latest: ImportFixtures.listingImport()),
            ImportFixtures.marketplace(
                .poshmark,
                canStart: false,
                reason: "Link Poshmark in Listora first, so it can read your listings.",
            ),
        ]])
        let model = ImportsModel(service: service)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.name) == ["Depop", "Poshmark"])
        let depop = model.rows[0]
        #expect(depop.latest?.summary == "Imported 42 from Depop, 3 need you")
        #expect(depop.latest?.tone == .actionNeeded)
        #expect(depop.startTitle == "Import again")
        #expect(model.rows[1].canStart == false)
        #expect(model.rows[1].unavailableReason == "Link Poshmark in Listora first, so it can read your listings.")
        #expect(model.rows[1].startTitle == "Import from Poshmark")
    }

    @Test
    func `starts an import, runs the phone's work, and sends a lost start again with its key`() async {
        let service = FakeImportsService()
        await service.set(marketplaces: [[ImportFixtures.marketplace(.depop)]])
        await service.set(start: [
            .failure(APIFailure(
                statusCode: nil,
                code: "network_unavailable",
                message: "You're offline.",
                retryable: true,
            )),
            .success(ImportFixtures.listingImport(
                status: .reading,
                progress: "Reading your Depop listings on your iPhone",
                summary: nil,
                needsYou: 0,
            )),
        ])
        let phone = RecordingPhoneWork()
        let model = ImportsModel(service: service)
        model.phoneWork = phone
        await model.load()
        await model.start(model.rows[0])
        #expect(model.notice?.tone == .failed)
        #expect(phone.reasons.isEmpty)
        await model.start(model.rows[0])
        let keys = await service.startKeys
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1], "a start whose answer was lost is sent again with its key")
        #expect(phone.reasons == [.userAction])
        #expect(model.notice?.message == "Listora is reading your Depop listings. It changes nothing on Depop.")
    }

    @Test
    func `reads again while an import runs, and stops once it is finished`() async {
        let service = FakeImportsService()
        await service.set(marketplaces: [
            [ImportFixtures.marketplace(
                .depop,
                canStart: false,
                latest: ImportFixtures.listingImport(
                    status: .reading,
                    progress: "Reading your Depop listings on your iPhone... 24 so far",
                    summary: nil,
                    needsYou: 0,
                ),
            )],
            [ImportFixtures.marketplace(
                .depop,
                canStart: false,
                latest: ImportFixtures.listingImport(
                    status: .importing,
                    progress: "Importing 12 of 48",
                    summary: "Imported 12 from Depop",
                    needsYou: 0,
                ),
            )],
            [ImportFixtures.marketplace(.depop, latest: ImportFixtures.listingImport(needsYou: 0, stoppedReason: nil))],
        ])
        let model = ImportsModel(service: service, pollInterval: .zero, sleep: { _ in })
        await model.watch()
        #expect(await service.marketplaceReads == 3)
        #expect(!model.isRunning)
        #expect(model.rows[0].latest?.tone == .success)
    }
}

@MainActor
@Suite("Import questions")
struct ImportQuestionsModelTests {
    @Test
    func `answers a question and drops it only once the server took the answer`() async {
        let service = FakeImportsService()
        await service.set(
            questions: [ImportFixtures.question(id: "q-1"), ImportFixtures.question(id: "q-2")],
            answers: [
                .failure(APIFailure(
                    statusCode: 409,
                    code: "invalid_state_transition",
                    message: "This question is already answered.",
                    retryable: false,
                )),
                .success(ImportFixtures.listingImport(summary: "Imported 43 from Depop, 1 needs you", needsYou: 1)),
            ],
        )
        let model = ImportQuestionsModel(importID: "import-1", service: service)
        await model.load()
        #expect(model.questions.count == 2)
        await model.answer(model.questions[0], .sameItem(itemID: "item-1"))
        #expect(model.failure == "This question is already answered.")
        #expect(model.questions.count == 2, "the list as the server has it")
        await model.answer(model.questions[1], .newItem)
        #expect(model.questions.map(\.id) == ["q-1"])
        #expect(model.summary == "Imported 43 from Depop, 1 needs you")
        let sent = await service.answers
        #expect(sent.map(\.questionID) == ["q-1", "q-2"])
        #expect(sent[0].answer.answer == .sameItem)
        #expect(sent[0].answer.itemId == "item-1")
        #expect(sent[1].answer.answer == .newItem)
    }
}
