import APIClient
import Foundation
import Testing
@testable import TasksFeature

@MainActor
struct OfferModelTests {
    let service = FakeOffersService()
    let phone = PhoneWorkCounter()

    func model(_ offer: Offer = OfferFixtures.offer()) -> OfferModel {
        OfferModel(offer: offer, service: service, runPhoneWork: { [phone] in phone.run() })
    }

    @Test
    func `shows the amount and what accepting gives after fees before anything is sent`() async {
        let model = model()
        model.confirmAccept()

        #expect(model.confirmation == .init(action: .accept, priceCents: 3000, netCents: 2670))
        #expect(await service.answers.isEmpty)
        #expect(phone.runs == 0)
    }

    @Test
    func `sends a confirmed answer once, then runs it on this phone at once`() async {
        let model = model()
        model.confirmAccept()
        await model.send()

        #expect(await service.answers.map(\.action) == [.accept])
        #expect(model.confirmation == nil)
        #expect(model.isAnswering)
        #expect(!model.can(.accept) && !model.can(.decline) && !model.can(.counter))
        #expect(phone.runs == 1)
        // A second tap has nothing to send.
        await model.send()
        #expect(await service.answers.count == 1)
    }

    @Test
    func `sends the answer an alert confirmed even after the alert cleared it as it closed`() async {
        let model = model()
        model.confirmAccept()
        let confirmed = model.confirmation
        model.cancelConfirmation()
        await model.send(confirmed)
        #expect(await service.answers.map(\.action) == [.accept])
    }

    @Test
    func `resends an answer whose reply was lost with the same key, and a refused one never`() async {
        let model = model()
        await service.failAnswers([.networkUnavailable, nil])
        model.confirmDecline()
        await model.send()
        #expect(model.problem != nil)
        #expect(model.confirmation != nil)
        await model.send()
        let keys = await service.answers.map(\.key)
        #expect(keys.count == 2 && keys[0] == keys[1])

        let refused = self.model()
        await service.failAnswers([.refused])
        refused.confirmAccept()
        await refused.send()
        #expect(refused.confirmation == nil)
        #expect(refused.problem == APIFailure.refused.message)
    }

    @Test
    func `counters only within the range, with what the price gives after fees`() async {
        let model = model()
        model.isCountering = true
        model.counterCents = 3000
        #expect(model.counterProblem == "Your price has to be more than $30.00.")
        model.counterCents = 4000
        #expect(model.counterProblem == "Your price has to be less than your listing price, $40.00.")
        await model.confirmCounter()
        #expect(model.confirmation == nil)

        model.counterCents = 3500
        await model.confirmCounter()
        #expect(model.confirmation == .init(action: .counter, priceCents: 3500, netCents: 3150))
        await model.send()
        let answers = await service.answers
        #expect(answers.map(\.action) == [.counter])
        #expect(answers.map(\.counterCents) == [3500])
        #expect(answers.map(\.offerAmountCents) == [3000])
        #expect(!model.isCountering)
    }

    @Test
    func `follows the answer until the marketplace's read-back says it is done`() async {
        let model = model()
        model.confirmAccept()
        await model.send()
        await service.setReads([
            OfferFixtures.offer(actions: [], response: OfferFixtures.response(
                status: "verifying", statusText: "Accepting... checking that Depop took it",
            )),
            OfferFixtures.offer(status: "accepted", actions: [], response: OfferFixtures.response(
                status: "succeeded", statusText: "Accepted (confirmed by Depop)",
            )),
        ])
        await model.follow(every: .milliseconds(1))

        #expect(!model.isAnswering)
        #expect(model.offer.status == "accepted")
        #expect(model.response?.statusText == "Accepted (confirmed by Depop)")
    }

    @Test
    func `an offer's task has no Done: only its answers finish it, and hiding it says the offer stays open`() {
        let task = Fixtures.task(
            kind: "answer_offer",
            title: "$30.00 offer on Depop",
            marketplace: "depop",
            operationID: nil,
            fields: [],
            photos: [],
        )
        let presentation = TaskPresentation(task)
        #expect(presentation.kind == .answerOffer)
        #expect(presentation.doneTitle == nil)
        #expect(presentation.openTitle == "Open in Depop")
        #expect(presentation.dismissMessage.contains("stays open on Depop"))
    }

    @Test
    func `opening Tasks asks the phone to read the offers, and runs it at once when a read waits`() async {
        let inbox = TaskInboxModel(
            service: FakeTasksService(), offers: service, reminders: RecordingReminders(),
            runPhoneWork: { [phone] in phone.run() },
        )
        await service.setChecks([OfferFixtures.decode(["marketplace": "depop", "status": "waiting"])])
        await inbox.checkOffers()
        #expect(await service.checkRequests == 1)
        #expect(phone.runs == 1)

        // A read that failed is the owner's to fix (read-health.md): the seller sees no error,
        // even from a server that still sends one.
        await service.setChecks([OfferFixtures.decode([
            "marketplace": "depop", "status": "failed",
            "message": "Listora couldn't read your offers on Depop's offers page.",
        ])])
        await inbox.checkOffers()
        #expect(phone.runs == 1)
        #expect(inbox.offerChecks.map(\.status) == ["failed"])
    }
}
