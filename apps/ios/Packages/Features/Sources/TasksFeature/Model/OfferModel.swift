import APIClient
import Foundation
import Observation

/// A buyer's offer (docs/features/offers.md): the amount, what accepting gives after fees, and
/// the seller's answer. Nothing is ever answered without the seller's tap on a confirmation that
/// shows the amount and what they get after fees. The answer is sent once, from this iPhone, and
/// the screen shows it as done only when the server has read the offer back from the marketplace.
@MainActor
@Observable
final class OfferModel {
    /// The confirmation on screen before anything is sent.
    struct Confirmation: Equatable, Identifiable {
        let action: OfferAction
        /// The price the answer is for: the offer's, or the counteroffer's.
        let priceCents: Int64
        /// What the seller gets after the marketplace's fees; nil for a decline.
        let netCents: Int64?

        var id: String {
            "\(action.rawValue)-\(priceCents)"
        }
    }

    private(set) var offer: Offer
    /// The seller chose Counter: the screen shows the price to type.
    var isCountering = false
    /// The counteroffer's price, as the seller types it.
    var counterCents: Int64?
    private(set) var confirmation: Confirmation?
    /// Why an answer, a quote, or a refresh did not go through; safe to show.
    private(set) var problem: String?
    private(set) var isSubmitting = false

    private let service: any OffersService
    /// Runs this phone's waiting work now, so the answer goes at once.
    private let runPhoneWork: @MainActor () -> Void
    /// One key per confirmed answer, reused when its reply was lost, so a second tap never
    /// answers twice.
    private var answerKey = UUID().uuidString
    private var keyFor: Confirmation?

    /// The offer's reads or answers show only because of the owner's Test mode
    /// (docs/features/test-mode.md): the screen tags it Testing.
    let isTesting: Bool

    init(
        offer: Offer,
        service: any OffersService,
        isTesting: Bool = false,
        runPhoneWork: @escaping @MainActor () -> Void = {},
    ) {
        self.offer = offer
        self.service = service
        self.isTesting = isTesting
        self.runPhoneWork = runPhoneWork
    }

    var marketplaceName: String {
        TaskPresentation.name(of: offer.marketplace)
    }

    /// Whether the offer takes this answer now: never while another is under way.
    func can(_ action: OfferAction) -> Bool {
        !isAnswering && offer.actions.contains { $0.value1 == action }
    }

    var response: OfferResponse? {
        offer.response
    }

    /// Whether an answer is under way: the screen follows it until it is read back or fails.
    var isAnswering: Bool {
        response.map(Self.isOpen) ?? false
    }

    var url: URL? {
        offer.url.flatMap(URL.init(string:))
    }

    // MARK: Asking

    func confirmAccept() {
        problem = nil
        confirmation = Confirmation(
            action: .accept,
            priceCents: offer.amount.amountCents,
            netCents: offer.accept.net.amountCents,
        )
    }

    func confirmDecline() {
        problem = nil
        confirmation = Confirmation(action: .decline, priceCents: offer.amount.amountCents, netCents: nil)
    }

    /// Why the typed counteroffer can't be sent, or nil.
    var counterProblem: String? {
        guard let cents = counterCents else { return "Enter your price." }
        if let range = offer.counterRange {
            if cents <= range.above.amountCents {
                return "Your price has to be more than \(Self.dollars(range.above.amountCents))."
            }
            if let below = range.below, cents >= below.amountCents {
                return "Your price has to be less than your listing price, \(Self.dollars(below.amountCents))."
            }
        }
        return nil
    }

    /// Asks the server what the counteroffer gives after fees, then shows its confirmation.
    func confirmCounter() async {
        guard let cents = counterCents, counterProblem == nil else { return }
        problem = nil
        do {
            let quote = try await service.quote(offerID: offer.id, priceCents: cents)
            confirmation = Confirmation(action: .counter, priceCents: cents, netCents: quote.net.amountCents)
        } catch {
            problem = error.message
        }
    }

    func cancelConfirmation() {
        confirmation = nil
    }

    // MARK: Sending

    /// Sends the confirmed answer (the one on screen, or `confirmed`, which an alert's button
    /// passes because the alert clears the confirmation as it closes), then runs it on this phone
    /// at once.
    func send(_ confirmed: Confirmation? = nil) async {
        guard let confirmation = confirmed ?? confirmation, !isSubmitting else { return }
        if keyFor != confirmation {
            answerKey = UUID().uuidString
            keyFor = confirmation
        }
        isSubmitting = true
        problem = nil
        defer { isSubmitting = false }
        do {
            let response = try await service.answer(
                offerID: offer.id,
                action: confirmation.action,
                offerAmountCents: offer.amount.amountCents,
                counterCents: confirmation.action == .counter ? confirmation.priceCents : nil,
                idempotencyKey: answerKey,
            )
            offer.response = response
            offer.actions = []
            isCountering = false
            self.confirmation = nil
            runPhoneWork()
        } catch {
            // A refusal is final for this key; an answer that never arrived is sent again as is.
            if error.statusCode != nil {
                keyFor = nil
                self.confirmation = nil
            } else {
                // Shown again, so the seller can send it again with the same key.
                self.confirmation = confirmation
            }
            problem = error.message
        }
    }

    /// Reads the offer again (its answer's progress).
    func refresh() async {
        do {
            offer = try await service.offer(id: offer.id)
        } catch {
            problem = error.message
        }
    }

    /// Reads the offer every `interval` while its answer is under way.
    func follow(every interval: Duration = .seconds(2)) async {
        while !Task.isCancelled, isAnswering {
            try? await Task.sleep(for: interval)
            if Task.isCancelled {
                return
            }
            await refresh()
        }
    }

    static func isOpen(_ response: OfferResponse) -> Bool {
        switch response.status.value1 {
        case .queued, .running, .verifying: true
        case .succeeded, .failed: false
        case nil: false
        }
    }

    static func dollars(_ cents: Int64) -> String {
        (Decimal(cents) / 100).formatted(.currency(code: "USD"))
    }
}
