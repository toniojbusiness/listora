import DesignSystem
import ListoraAPI
import SwiftUI

/// Which change the bulk sheet makes.
enum BulkActionKind: String, Identifiable, CaseIterable {
    case list
    case changePrice
    case end
    case relist
    case delete

    var id: String {
        rawValue
    }

    /// The selection bar's button.
    var buttonTitle: String {
        switch self {
        case .list: "List all"
        case .changePrice: "Price"
        case .end: "End all"
        case .relist: "Relist all"
        case .delete: "Delete"
        }
    }

    /// What the selection bar's button does, for VoiceOver.
    var accessibilityLabel: String {
        switch self {
        case .list: "List all"
        case .changePrice: "Change price"
        case .end: "End all"
        case .relist: "Relist all"
        case .delete: "Delete"
        }
    }

    var systemImage: String {
        switch self {
        case .list: "tag.fill"
        case .changePrice: "dollarsign.circle"
        case .end: "xmark.circle"
        case .relist: "arrow.counterclockwise"
        case .delete: "trash"
        }
    }

    func title(count: Int) -> String {
        let items = count == 1 ? "1 item" : "\(count) items"
        return switch self {
        case .list: "List \(items)"
        case .changePrice: "Change the price of \(items)"
        case .end: "End \(items)"
        case .relist: "Relist \(items)"
        case .delete: "Delete \(items)"
        }
    }
}

struct OutcomeGroup {
    let itemID: String
    let title: String
    let sku: String
    var outcomes: [BulkOutcome]
}

/// One item's results: each marketplace's (or the item's own) outcome in plain words.
struct OutcomeCard: View {
    let group: OutcomeGroup

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Text(group.title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(group.sku)
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize()
            }
            ForEach(group.outcomes) { outcome in
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    StatusLabel(
                        outcome.marketplace.map(Formatting.marketplaceName) ?? "Item",
                        tone: outcome.tone,
                    )
                    Text(outcome.message)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("bulk.outcome.\(group.sku).\(outcome.marketplace ?? "item")")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(group.outcomes.contains { $0.result == .failed } ? .tinted(.failed) : .elevated)
    }
}

/// A marketplace to list on, with how Listora lists there or why it can't yet.
struct DestinationRow: View {
    let destination: BulkActionModel.Destination
    @Binding var isOn: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
        Toggle(isOn: $isOn) {
            layout {
                IconTile(
                    monogram: String(destination.name.prefix(1)),
                    tone: destination.isAvailable ? nil : .neutral,
                )
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(destination.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    Text(destination.detail)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .tint(Palette.brand.color)
        .disabled(!destination.isAvailable)
        .cardStyle(.flat)
        .accessibilityLabel("\(destination.name), \(destination.detail)")
        .accessibilityIdentifier("bulk.marketplace.\(destination.id)")
    }
}

extension BulkOutcome {
    var tone: StatusTone {
        switch result {
        case .started: .inProgress
        case .done: .success
        case .skipped: .actionNeeded
        case .failed: .failed
        }
    }
}

extension EndReason {
    /// "Sold elsewhere", for a choice that already says it ends.
    var shortTitle: String {
        switch self {
        case .soldElsewhere: "Sold elsewhere"
        case .notAvailable: "No longer available"
        }
    }
}

extension String {
    /// "3 started" to "3 started"; "started" to "Started".
    var capitalizedFirst: String {
        prefix(1).uppercased() + dropFirst()
    }
}
