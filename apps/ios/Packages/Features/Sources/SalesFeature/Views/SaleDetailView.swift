import DesignSystem
import ListoraAPI
import SwiftUI

/// One sale: what sold, where, and for how much; each fee (estimated until the marketplace
/// reports it); the payout, profit, and ROI; the delist on every other marketplace, exactly as
/// the server words it; and the steps the sale's status allows. After a cancel or return it asks
/// whether to relist, and relists only where the seller chooses.
struct SaleDetailView: View {
    @State private var model: SaleDetailModel
    @State private var confirming: Components.Schemas.KnownSaleAction?
    @State private var shipping = false

    init(environment: SalesEnvironment, saleID: String) {
        _model = State(initialValue: environment.makeDetailModel(saleID: saleID))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Sale")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await model.load()
                await model.followChanges()
            }
            .refreshable { await model.load() }
            .sheet(isPresented: $shipping) {
                ShipSaleView { labelCost in
                    shipping = false
                    Task { await model.perform(.markShipped(labelCostCents: labelCost)) }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.sale == nil:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    SkeletonBlock(width: 220, height: 22)
                    SkeletonRow().cardStyle()
                    SkeletonRow().cardStyle()
                }
                .padding(Spacing.md)
            }
            .scrollDisabled(true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading sale")
        case let .failed(message) where model.sale == nil:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Sale unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if let sale = model.sale {
                details(of: sale)
            }
        }
    }

    private func details(of sale: Sale) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SaleHeader(sale: sale)
                if let notice = model.notice {
                    Banner(
                        "That didn't go through",
                        message: notice,
                        tone: .failed,
                        onDismiss: { model.notice = nil },
                        identifier: "sale.notice",
                    )
                    .transition(.rise)
                }
                ForEach(sale.doubleSales, id: \.taskId) { double in
                    Banner(double.title, message: double.steps.joined(separator: " "), tone: .actionNeeded)
                }
                if sale.items.contains(where: { $0.relist != nil }) {
                    RelistSection(sale: sale, model: model)
                }
                if !sale.delistRuns.isEmpty {
                    DelistSection(sale: sale)
                }
                MoneySection(sale: sale)
                if sale.items.count > 1 {
                    ItemsSection(sale: sale)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.notice)
        }
        .bottomActionBar {
            if !sale.knownActions.isEmpty {
                actions(for: sale)
            }
        }
    }

    /// The main next step (ship, or record a return) full width; the others as text buttons below.
    private func actions(for sale: Sale) -> some View {
        let actions = sale.knownActions
        let primary = actions.first { $0 == .markShipped || $0 == .recordReturn }
        return VStack(spacing: Spacing.xs) {
            if let primary {
                actionButton(primary)
                    .buttonStyle(.listoraPrimary)
            }
            HStack(spacing: Spacing.md) {
                ForEach(actions.filter { $0 != primary }, id: \.self) { action in
                    actionButton(action)
                        .buttonStyle(.listora(action == .cancel ? .destructiveText : .tertiary, size: .compact))
                }
            }
        }
        .disabled(model.isSending)
    }

    @ViewBuilder
    private func actionButton(_ action: Components.Schemas.KnownSaleAction) -> some View {
        switch action {
        case .confirm:
            Button("Confirm sale", systemImage: "checkmark") { Task { await model.perform(.confirm) } }
                .accessibilityIdentifier("sale.action.confirm")
        case .markShipped:
            Button("Mark shipped", systemImage: "shippingbox") { shipping = true }
                .accessibilityIdentifier("sale.action.markShipped")
        case .cancel:
            Button("Cancel sale", systemImage: "xmark") { confirming = .cancel }
                .accessibilityIdentifier("sale.action.cancel")
                .modifier(confirmation(of: .cancel))
        case .recordReturn:
            Button("Record return", systemImage: "arrow.uturn.backward") { confirming = .recordReturn }
                .accessibilityIdentifier("sale.action.recordReturn")
                .modifier(confirmation(of: .recordReturn))
        }
    }

    /// The confirmation of a cancel or a return, on its own button so it opens where it was tapped.
    private func confirmation(of action: Components.Schemas.KnownSaleAction) -> SaleActionConfirmation {
        SaleActionConfirmation(
            action: action,
            isPresented: Binding(get: { confirming == action }, set: {
                if !$0 {
                    confirming = nil
                }
            }),
        ) {
            confirming = nil
            Task { await model.perform(action == .cancel ? .cancel : .recordReturn) }
        }
    }
}

/// "Cancel this sale?" or "Record a return?", with what happens next.
private struct SaleActionConfirmation: ViewModifier {
    let action: Components.Schemas.KnownSaleAction
    @Binding var isPresented: Bool
    let confirm: () -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            action == .cancel ? "Cancel this sale?" : "Record a return?",
            isPresented: $isPresented,
            titleVisibility: .visible,
        ) {
            Button(action == .cancel ? "Cancel sale" : "Record return", role: .destructive, action: confirm)
                .accessibilityIdentifier("sale.confirm.\(action.rawValue)")
            Button("Keep the sale", role: .cancel) {}
        } message: {
            Text("The item goes back to your inventory. Listora then asks whether to relist it, "
                + "and relists nothing until you choose.")
        }
    }
}

/// What sold, where, when, and for how much.
private struct SaleHeader: View {
    let sale: Sale

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Text(sale.title)
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Text(SaleFormatting.money(sale.salePrice))
                    .font(Typography.price)
                    .foregroundStyle(Palette.brand)
            }
            HStack(spacing: Spacing.xs) {
                Text("Sold on \(sale.marketplace.name) · \(SaleFormatting.day(sale.soldAt))")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("sale.soldOn")
                StatusBadge(sale.status.label, tone: sale.status.tone, showsIcon: false)
                    .accessibilityIdentifier("sale.status")
            }
        }
    }
}
