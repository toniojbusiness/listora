import DesignSystem
import ListoraAPI
import SwiftUI

/// How Listora found the sale and what it then did on each other marketplace
/// (docs/features/activity.md): which check saw it, where and when, when it was recorded, and
/// each delist with its result and when it settled. The words are the server's.
struct FoundSection: View {
    let explanation: SaleExplanation

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("How Listora found it", subtitle: explanation.detection)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(FoundSectionContent(explanation).facts, id: \.self) { fact in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        Text(fact.label)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                        Spacer(minLength: Spacing.sm)
                        Text(fact.value)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textPrimary)
                            .multilineTextAlignment(.trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
                ForEach(Array(explanation.delists.enumerated()), id: \.offset) { _, delist in
                    Divider()
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(delist.marketplace.name)
                            .font(Typography.emphasis)
                            .foregroundStyle(Palette.textPrimary)
                        Text(delist.result)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(FoundSectionContent.delistTiming(delist))
                            .font(Typography.metadata)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("sale.found.delist.\(delist.marketplace.value1?.rawValue ?? "other")")
                }
                ForEach(packageEntries, id: \.id) { entry in
                    Divider()
                    PackageEntryRow(entry: entry)
                }
            }
            .cardStyle()
        }
        .accessibilityIdentifier("sale.found")
    }

    /// Pack check's package: how it was packed, and its photo for a claim (docs/features/pack-check.md).
    private var packageEntries: [Components.Schemas.ActivityEntry] {
        explanation.entries.filter { $0.kind.value1 == .package }.reversed()
    }
}

/// One Pack check entry: "Packed with the label ending 8490", and the package photo, large
/// enough to show in a claim.
private struct PackageEntryRow: View {
    let entry: Components.Schemas.ActivityEntry

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(entry.title)
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textPrimary)
            if let detail = entry.detail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(entry.at.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                .font(Typography.metadata)
                .foregroundStyle(Palette.textSecondary)
            if let url = entry.photoUrl.flatMap(URL.init(string:)) {
                RemoteImage(url: url) {
                    Palette.surfaceSecondary.color
                }
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                .accessibilityLabel("Photo of the open package")
                .accessibilityIdentifier("sale.found.packagePhoto")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sale.found.\(entry.id.hasPrefix("package_photo") ? "packagePhotoEntry" : "packed")")
    }
}

/// The facts of ``FoundSection``, worded for the screen.
struct FoundSectionContent {
    struct Fact: Hashable {
        let label: String
        let value: String
    }

    let facts: [Fact]

    init(_ explanation: SaleExplanation) {
        var facts: [Fact] = [Fact(label: "Sold", value: Self.time(explanation.soldAt))]
        if let check = explanation.check {
            let place = check.host.value1 == .phone ? "On your iPhone" : "In Listora's cloud browser"
            facts.append(Fact(label: "Seen by a sale check", value: "\(place), \(Self.time(check.startedAt))"))
            if let seen = check.ordersSeen {
                facts.append(Fact(label: "That check saw", value: seen == 1 ? "1 sold order" : "\(seen) sold orders"))
            }
        } else if let reported = explanation.reportedAt {
            facts.append(Fact(label: "Reported", value: Self.time(reported)))
        }
        facts.append(Fact(label: "Recorded", value: Self.time(explanation.recordedAt)))
        self.facts = facts
    }

    /// "Started 2:41 PM, done 2:43 PM", or "Started 2:41 PM" while it runs.
    static func delistTiming(_ delist: Components.Schemas.SaleDelist) -> String {
        let started = "Started \(time(delist.startedAt))"
        guard let settled = delist.settledAt else { return started }
        return "\(started), settled \(time(settled))"
    }

    private static func time(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
