import DesignSystem
import ListoraAPI
import SwiftUI

/// What a forwarded sale email said: the item, its price and time, and a short excerpt with the
/// buyer's details removed (all Listora keeps of the email).
struct SaleEmailStep: View {
    let number: Int
    let email: Components.Schemas.UserTaskSaleEmail
    let marketplaceName: String

    var body: some View {
        StepCard(number: number, title: "What the \(marketplaceName) email says") {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                if let title = email.title {
                    Text(title)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityIdentifier("task.saleEmail.title")
                }
                let facts = [
                    email.salePrice.map { "Sold for \(Self.money($0))" },
                    email.soldAt.map { $0.formatted(date: .abbreviated, time: .shortened) },
                    email.orderNumber.map { "Order \($0)" },
                ].compactMap(\.self)
                if !facts.isEmpty {
                    Text(facts.joined(separator: " · "))
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("task.saleEmail.facts")
                }
                if !email.excerpt.isEmpty {
                    Text(email.excerpt)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .padding(Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            Palette.surfaceSecondary,
                            in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous),
                        )
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("The email: \(email.excerpt)")
                }
            }
        }
    }

    /// "$45.00" (USD only for now).
    private static func money(_ money: Components.Schemas.Money) -> String {
        (Decimal(money.amountCents) / 100).formatted(.currency(code: money.currency.rawValue))
    }
}

/// A sale email review's candidates: the user picks the item that sold.
struct PickItemStep: View {
    let number: Int
    let model: TaskDetailModel

    var body: some View {
        StepCard(number: number, title: "Pick the item that sold") {
            VStack(spacing: 0) {
                ForEach(Array(model.candidates.enumerated()), id: \.element.id) { index, item in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color)
                    }
                    HStack(alignment: .center, spacing: Spacing.sm) {
                        RemoteImage(url: (item.coverPhoto?.urls?.thumbnail).flatMap(URL.init(string:))) {
                            Palette.surfaceSecondary.color
                        }
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title ?? "Untitled item")
                                .font(Typography.body)
                                .foregroundStyle(Palette.textPrimary)
                                .lineLimit(2)
                            Text(item.sku)
                                .font(Typography.caption)
                                .foregroundStyle(Palette.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button("This one") {
                            Task { await model.pick(itemID: item.id) }
                        }
                        .buttonStyle(.listora(.secondary, size: .compact))
                        .disabled(model.isSubmitting)
                        .accessibilityLabel("\(item.title ?? item.sku) sold")
                        .accessibilityIdentifier("task.pick.\(item.sku)")
                    }
                    .padding(.vertical, Spacing.xs)
                }
            }
            Text("Listora records the sale and delists it everywhere else.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}
