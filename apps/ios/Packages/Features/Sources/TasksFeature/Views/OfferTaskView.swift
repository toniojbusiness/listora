import DesignSystem
import SwiftUI

/// A buyer's offer on the task screen (docs/features/offers.md): the offer on a price tag, what
/// accepting gives after fees, the answer under way in honest words, the counteroffer's price,
/// and Open in the marketplace. Nothing is sent before a confirmation that shows the amount and
/// what the seller gets after fees.
struct OfferTaskView: View {
    @Bindable var model: OfferModel
    let open: (URL) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            OfferTag(offer: model.offer, marketplaceName: model.marketplaceName)
            if model.isTesting {
                TestingTag()
            }
            if let response = model.response {
                ResponseStatus(response: response, marketplaceName: model.marketplaceName)
            } else {
                acceptNote
            }
            if let problem = model.problem {
                Banner(problem, tone: .failed, identifier: "offer.problem")
            }
            if model.isCountering, model.can(.counter) {
                counterEntry
            }
            if let url = model.url {
                Button("Open in \(model.marketplaceName)", systemImage: "arrow.up.right.square") { open(url) }
                    .buttonStyle(.listoraSecondary)
                    .accessibilityIdentifier("offer.open")
            }
        }
        .task(id: model.isAnswering) { await model.follow() }
        .alert(
            confirmationTitle,
            isPresented: Binding(
                get: { model.confirmation != nil },
                set: {
                    if !$0 {
                        model.cancelConfirmation()
                    }
                },
            ),
            presenting: model.confirmation,
        ) { confirmation in
            Button("Cancel", role: .cancel) { model.cancelConfirmation() }
            Button(confirmButton(confirmation), role: confirmation.action == .decline ? .destructive : nil) {
                Task { await model.send(confirmation) }
            }
            .accessibilityIdentifier("offer.confirm")
        } message: { confirmation in
            Text(confirmMessage(confirmation))
        }
    }

    /// Accept and Counter, for the screen's bottom bar.
    @ViewBuilder
    var actions: some View {
        if model.can(.accept) {
            Button("Accept \(OfferModel.dollars(model.offer.amount.amountCents))", systemImage: "checkmark") {
                model.confirmAccept()
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isSubmitting && model.confirmation?.action == .accept)
            .accessibilityIdentifier("offer.accept")
        }
        if model.can(.counter), !model.isCountering {
            Button("Counter", systemImage: "arrow.left.arrow.right") { model.isCountering = true }
                .buttonStyle(.listoraSecondary)
                .accessibilityIdentifier("offer.counter")
        }
    }

    /// Decline, which sits beside Hide this offer in the bottom bar.
    @ViewBuilder
    var declineAction: some View {
        if model.can(.decline) {
            Button("Decline") { model.confirmDecline() }
                .buttonStyle(.listora(.destructiveText, size: .large))
                .disabled(model.isSubmitting)
                .accessibilityIdentifier("offer.decline")
        }
    }

    private var acceptNote: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            let net = OfferModel.dollars(model.offer.accept.net.amountCents)
            Text("Accepting gives you about \(net) after \(model.marketplaceName)'s fees.")
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("offer.net")
            Text(model.offer.acceptNote)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var counterEntry: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            PriceField(
                "Your price",
                minorUnits: Binding(
                    get: { model.counterCents.map { Int($0) } },
                    set: { model.counterCents = $0.map { Int64($0) } },
                ),
                hint: model.counterProblem ?? "The buyer can accept it, counter, or let it go.",
            )
            .accessibilityIdentifier("offer.counterPrice")
            Button("Review counteroffer") { Task { await model.confirmCounter() } }
                .buttonStyle(.listoraPrimary)
                .disabled(model.counterProblem != nil)
                .accessibilityIdentifier("offer.reviewCounter")
        }
        .cardStyle()
    }

    private var confirmationTitle: String {
        guard let confirmation = model.confirmation else { return "" }
        let price = OfferModel.dollars(confirmation.priceCents)
        return switch confirmation.action {
        case .accept: "Accept the \(price) offer?"
        case .decline: "Decline the \(price) offer?"
        case .counter: "Counter at \(price)?"
        }
    }

    private func confirmButton(_ confirmation: OfferModel.Confirmation) -> String {
        let price = OfferModel.dollars(confirmation.priceCents)
        return switch confirmation.action {
        case .accept: "Accept \(price)"
        case .decline: "Decline offer"
        case .counter: "Send counteroffer"
        }
    }

    private func confirmMessage(_ confirmation: OfferModel.Confirmation) -> String {
        let name = model.marketplaceName
        let net = confirmation.netCents.map(OfferModel.dollars) ?? ""
        let honest = "Listora answers from this iPhone and shows it as done once \(name) shows it."
        return switch confirmation.action {
        case .accept: "You get about \(net) after \(name)'s fees. \(model.offer.acceptNote) \(honest)"
        case .decline: "The buyer's offer ends. \(honest)"
        case .counter: "If the buyer accepts, you get about \(net) after \(name)'s fees. \(honest)"
        }
    }
}

/// The offer on a price tag: the amount in the tag's print, the listing, the buyer, and when it
/// expires; a stamp once it is answered.
private struct OfferTag: View {
    let offer: Offer
    let marketplaceName: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(OfferModel.dollars(offer.amount.amountCents))
                    .font(Typography.priceLarge)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("offer.amount")
                Spacer(minLength: Spacing.sm)
                if let stamp {
                    Stamp(stamp.text, tone: stamp.tone, angle: .degrees(-6))
                }
            }
            if let listPrice = offer.listPrice {
                Text("Offer on your \(OfferModel.dollars(listPrice.amountCents)) listing")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            if let title = offer.listingTitle {
                Text(title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
            }
            details
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tagStyle()
    }

    @ViewBuilder
    private var details: some View {
        let lines = [
            offer.buyerName.map { "From \($0) on \(marketplaceName)" },
            offer.listingCount.map { "A bundle of \($0) listings" },
            offer.shipping.map { "Buyer pays \(OfferModel.dollars($0.amountCents)) shipping" },
        ].compactMap(\.self)
        ForEach(lines, id: \.self) { line in
            Text(line)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
        if let expiresAt = offer.expiresAt, offer.status == "pending" {
            (Text("Expires ") + Text(expiresAt, format: .relative(presentation: .named)))
                .font(Typography.smallEmphasis)
                .foregroundStyle(expiresAt.timeIntervalSinceNow < 6 * 3600 ? Palette.warning : Palette.textSecondary)
                .accessibilityIdentifier("offer.expires")
        }
    }

    /// The offer's answered state as a stamp; none while it waits on the seller.
    private var stamp: (text: String, tone: StatusTone)? {
        switch offer.status {
        case "accepted": ("Accepted", .success)
        case "declined": ("Declined", .neutral)
        case "countered": ("Countered", .inProgress)
        case "closed": ("Closed", .neutral)
        default: nil
        }
    }
}

/// The answer under way, or how it ended, in the server's words.
private struct ResponseStatus: View {
    let response: OfferResponse
    let marketplaceName: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            StatusLabel(response.statusText, tone: tone)
                .accessibilityIdentifier("offer.status")
            if let error = response.error {
                Text(error.message)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("offer.error")
                if !error.retryable {
                    Text("Check the offer in \(marketplaceName) before you answer again.")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
        }
    }

    private var tone: StatusTone {
        switch response.status.value1 {
        case .queued, .running, .verifying: .inProgress
        case .succeeded: .success
        case .failed: .failed
        case nil: .neutral
        }
    }
}
