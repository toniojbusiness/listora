import Core
import DesignSystem
import SwiftUI

/// Starting a run (docs/features/thrift-scan.md, "Runs"): where the seller is, picked from the
/// places they bought from lately or typed, or left out. Nothing else is asked.
struct ScanStartView: View {
    let recentPlaces: [String]
    let onStart: (_ place: String?) -> Void
    let onCancel: () -> Void
    @State private var place = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text("The haul takes this place at checkout. You can leave it out.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                    ListoraTextField("Where you are") {
                        TextField(
                            "Where you are",
                            text: $place,
                            prompt: Text("Thrift store, estate sale, ...").foregroundStyle(Palette.textSecondary),
                        )
                        .submitLabel(.go)
                        .onSubmit { onStart(place) }
                        .accessibilityIdentifier("scanStart.place")
                    }
                    if !recentPlaces.isEmpty {
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text("Recent")
                                .font(Typography.footnote)
                                .foregroundStyle(Palette.textSecondary)
                            FlowLayout {
                                ForEach(recentPlaces, id: \.self) { recent in
                                    ChoiceChip(recent, isSelected: place == recent) { place = recent }
                                        .accessibilityIdentifier("scanStart.recentPlace")
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: Layout.readableWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .navigationTitle("Start a run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
            .bottomActionBar {
                Button {
                    onStart(place)
                } label: {
                    Label("Start scanning", systemImage: "camera.viewfinder")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("scanStart.start")
            }
        }
    }
}

/// Checkout at the register (docs/features/thrift-scan.md, "Checkout"): what the seller paid
/// for the haul, how many items it had (the kept ones unless they say otherwise), and the miles,
/// if they log them. Once Listora recorded the haul, the run's summary replaces the form.
struct ScanCheckoutView: View {
    typealias Submit = (_ checkout: ScanCheckoutModel, _ totalCents: Int64, _ itemCount: Int, _ miles: Int?) async
        -> Void

    let checkout: ScanCheckoutModel
    let onCheckout: Submit
    let onDone: () -> Void
    @State private var totalCents: Int?
    @State private var itemCount: String
    @State private var miles = ""

    init(checkout: ScanCheckoutModel, onCheckout: @escaping Submit, onDone: @escaping () -> Void) {
        self.checkout = checkout
        self.onCheckout = onCheckout
        self.onDone = onDone
        _itemCount = State(initialValue: "\(max(checkout.run.keptCount, 1))")
    }

    private var run: ScanRunModel {
        checkout.run
    }

    /// What the form holds, once it is a checkout Listora accepts.
    private struct Entry {
        let totalCents: Int64
        let itemCount: Int
        let miles: Int?
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if let summary = checkout.summary {
                        ScanRunSummaryView(card: RunSummaryCard(summary))
                    } else {
                        form
                    }
                }
                .frame(maxWidth: Layout.readableWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.background)
            .navigationTitle(checkout.summary == nil ? "Checkout" : "Run summary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if checkout.summary == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onDone).disabled(checkout.isCheckingOut)
                    }
                }
            }
            .bottomActionBar { actions }
            .interactiveDismissDisabled(checkout.isCheckingOut)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(run.place ?? "This run")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(counts)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textSecondary)
            }
            PriceField(
                "Paid for the haul",
                minorUnits: $totalCents,
                hint: "Each item costs its share. Profit shows once this is in.",
            )
            ListoraTextField("Items in the haul", hint: itemsHint, error: itemsError) {
                TextField("Items in the haul", text: $itemCount)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("scanCheckout.items")
            }
            ListoraTextField("Miles driven (optional)", error: milesError) {
                TextField(
                    "Miles driven (optional)",
                    text: $miles,
                    prompt: Text("For your mileage log").foregroundStyle(Palette.textSecondary),
                )
                .keyboardType(.numberPad)
                .accessibilityIdentifier("scanCheckout.miles")
            }
            if run.isKeeping {
                Label("Saving the items you kept...", systemImage: "arrow.down.circle")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            if let failure = checkout.failure {
                Banner(
                    "Couldn't check out",
                    message: "\(failure) Nothing was recorded; check out again to retry.",
                    tone: .failed,
                    systemImage: "exclamationmark.triangle.fill",
                    identifier: "scanCheckout.failure",
                )
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if checkout.summary != nil {
            Button("Done", action: onDone)
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("scanCheckout.done")
        } else {
            Button {
                guard let entry else { return }
                Task { await onCheckout(checkout, entry.totalCents, entry.itemCount, entry.miles) }
            } label: {
                if checkout.isCheckingOut {
                    HStack(spacing: Spacing.xs) {
                        BrandSpinner()
                        Text("Checking out")
                    }
                } else {
                    Label("Check out", systemImage: "cart.badge.plus")
                }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(entry == nil || !checkout.canCheckOut)
            .accessibilityIdentifier("scanCheckout.submit")
        }
    }

    private var counts: String {
        let kept = run.keptCount == 1 ? "1 kept" : "\(run.keptCount) kept"
        return "\(run.entries.count) scanned · \(kept)"
    }

    private var itemsHint: String {
        run.keptCount == 1
            ? "The 1 you kept, or more if you bought some without scanning"
            : "The \(run.keptCount) you kept, or more if you bought some without scanning"
    }

    private var parsedItems: Int? {
        Int(itemCount.trimmingCharacters(in: .whitespaces)).flatMap { (1 ... 10000).contains($0) ? $0 : nil }
    }

    private var parsedMiles: Int?? {
        let text = miles.trimmingCharacters(in: .whitespaces)
        if text.isEmpty {
            return .some(nil)
        }
        return Int(text).flatMap { (0 ... 2000).contains($0) ? .some($0) : nil }
    }

    private var itemsError: String? {
        if parsedItems == nil {
            return "Enter how many items, 1 or more"
        }
        if let parsedItems, parsedItems < run.keptCount {
            return "The haul gets at least the \(run.keptCount) you kept"
        }
        return nil
    }

    private var milesError: String? {
        parsedMiles == nil ? "Enter whole miles, up to 2,000" : nil
    }

    private var entry: Entry? {
        guard let totalCents, totalCents >= 0, let parsedItems, let parsedMiles else { return nil }
        return Entry(totalCents: Int64(totalCents), itemCount: max(parsedItems, run.keptCount), miles: parsedMiles)
    }
}

/// A checked-out run (Hang Tag): a tag stamped "Checked out", the haul's cost, the kept items'
/// estimated resale in the tag's print, and the estimated profit with its label. No number on it
/// is a sale; each says it is an estimate.
struct ScanRunSummaryView: View {
    let card: RunSummaryCard

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Stamp(card.paid == nil ? "This run" : "Checked out", tone: .success, angle: .degrees(-3))
                Spacer(minLength: 0)
                Text(card.counts)
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("runSummary.counts")
            }
            Text(card.title)
                .font(Typography.title)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)
            if let paid = card.paid {
                Text(paid)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("runSummary.paid")
            }
            if let resale = card.resale {
                Divider().overlay(Palette.separator.color)
                line("Estimated resale", value: resale, font: Typography.priceLarge, identifier: "runSummary.resale")
                if let payout = card.payout {
                    Text(payout).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
                }
            }
            if let profit = card.profit {
                line(
                    "Estimated profit",
                    value: profit,
                    font: Typography.price,
                    tone: card.profitTone,
                    identifier: "runSummary.profit",
                )
                if let label = card.profitLabel {
                    Text(label).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
                }
            }
            if card.basedOn != nil || card.estimateLabel != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let basedOn = card.basedOn {
                        Text(basedOn).accessibilityIdentifier("runSummary.basedOn")
                    }
                    if let label = card.estimateLabel {
                        Text(label).accessibilityIdentifier("runSummary.label")
                    }
                }
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
        }
        .tagStyle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("runSummary")
    }

    private func line(
        _ title: String,
        value: String,
        font: Font,
        tone: StatusTone? = nil,
        identifier: String,
    ) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(Typography.emphasis).foregroundStyle(Palette.textSecondary)
            Spacer(minLength: Spacing.xs)
            Text(value)
                .font(font)
                .foregroundStyle(tone.map { AnyShapeStyle($0.color) } ?? AnyShapeStyle(Palette.textPrimary))
                .accessibilityIdentifier(identifier)
        }
        .accessibilityElement(children: .combine)
    }
}
