import DesignSystem
import SwiftUI

/// Settings > Pack check: the switch, and what it does, in plain words. Off by default.
struct PackCheckSettingsView: View {
    let environment: PackCheckEnvironment
    private var model: PackCheckSettingsModel {
        environment.settings
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Pack check")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 2, label: "Loading Pack check")
        case let .failed(message):
            EmptyStateView(
                systemImage: "shippingbox",
                tone: .failed,
                title: "Setting unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Toggle("Check each package before it ships", isOn: enabled)
                        .font(Typography.body)
                        .tint(Palette.brand.color)
                        .disabled(model.isSaving)
                        .cardStyle(.flat)
                        .accessibilityIdentifier("packCheck.enabled")
                    if let error = model.saveError {
                        Banner("Couldn't save", message: error, tone: .failed)
                    }
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        explanation(
                            "list.bullet.rectangle",
                            "A to-ship list",
                            "Every sale to pack, with the item's photo, SKU, shelf, the buyer's first name, "
                                + "and the label's tracking number from the marketplace.",
                        )
                        explanation(
                            "barcode.viewfinder",
                            "Scan the label",
                            "Listora shows which item the label is for, and stops you if it's another "
                                + "package's label or one you already used.",
                        )
                        explanation(
                            "qrcode",
                            "Item stickers",
                            "Print a small SKU sticker for each item. Scanning it with the label makes "
                                + "the match exact.",
                        )
                        explanation(
                            "camera",
                            "Package photo and packing slip",
                            "Keep a photo of the open package for a claim, and print a slip to put inside.",
                        )
                    }
                    .cardStyle(.flat)
                    Text("Pack check only reads your marketplaces. It never changes a listing or an order.")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.isEnabled {
                        NavigationLink {
                            environment.ordersScreen()
                        } label: {
                            Label("Open the to-ship list", systemImage: "shippingbox")
                        }
                        .buttonStyle(ListoraButtonStyle(.primary))
                        .accessibilityIdentifier("packCheck.openList")
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { model.isEnabled },
            set: { value in Task { await model.setEnabled(value) } },
        )
    }

    private func explanation(_ systemImage: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(Palette.brand.color)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title).font(Typography.headline)
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
