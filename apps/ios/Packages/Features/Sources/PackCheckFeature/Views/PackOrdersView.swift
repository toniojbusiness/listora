import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The to-ship list: one card per order that still needs a package, then the ones packed today.
/// "Pack all" goes through every unpacked order in turn; a card packs just that one. Under each
/// card: its stickers to print, and its label with them (or the order's page on the marketplace,
/// where Listora can't print its label). The first time it opens, "How Pack check works" shows.
struct PackOrdersView: View {
    let environment: PackCheckEnvironment
    @Bindable var model: PackOrdersModel
    @State private var session: PackSessionModel?
    @State private var printingStickers: StickerBatch?
    @State private var printingLabel: LabelPrintModel?
    @State private var explaining = false

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Pack orders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("How it works", systemImage: "questionmark.circle") { explaining = true }
                        .accessibilityIdentifier("pack.howItWorks")
                }
            }
            .task {
                if !environment.defaults.bool(forKey: PackCheckExplainer.seenKey) {
                    environment.defaults.set(true, forKey: PackCheckExplainer.seenKey)
                    explaining = true
                }
                await model.refresh()
            }
            .refreshable { await model.refresh() }
            .fullScreenCover(item: sessionBinding) { session in
                PackSessionView(model: session, scanSource: environment.scanSource) {
                    self.session = nil
                }
            }
            .sheet(isPresented: $explaining) { PackCheckExplainerSheet() }
            .sheet(item: $printingStickers) { batch in StickerPrintView(stickers: batch.stickers) }
            .sheet(item: $printingLabel) { print in LabelPrintView(model: print) }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 3, label: "Loading the orders to pack")
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to pack your orders",
                message: "Your sales to ship show up here once you sign in.",
            )
        case let .failed(message):
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Orders unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            if model.orders.isEmpty {
                EmptyStateView(
                    systemImage: "shippingbox",
                    title: "Nothing to pack",
                    message: "When an item sells, its order shows up here to pack.",
                )
                .accessibilityIdentifier("pack.empty")
            } else {
                list
            }
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                if model.readingLabels > 0 {
                    Banner(
                        "Reading shipping labels",
                        message: "Your iPhone is reading \(readingCount) from the marketplaces. "
                            + "It only reads; nothing changes there.",
                        tone: .inProgress,
                    )
                }
                if !model.unpacked.isEmpty {
                    Button {
                        start(model.unpacked)
                    } label: {
                        Label(
                            model.unpacked.count == 1 ? "Pack 1 order" : "Pack all \(model.unpacked.count) orders",
                            systemImage: "barcode.viewfinder",
                        )
                    }
                    .buttonStyle(ListoraButtonStyle(.primary))
                    .accessibilityIdentifier("pack.startAll")
                    SectionHeader("To pack", subtitle: "\(model.unpacked.count) not packed")
                    ForEach(model.unpacked, id: \.saleId) { order in
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            Button { start([order]) } label: { PackOrderCard(order: order) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("pack.order.\(order.items.first?.sku ?? order.saleId)")
                            printActions(order)
                        }
                    }
                }
                if !model.packed.isEmpty {
                    SectionHeader("Packed today")
                    ForEach(model.packed, id: \.saleId) { order in
                        Button { start([order]) } label: { PackOrderCard(order: order) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("pack.order.\(order.items.first?.sku ?? order.saleId)")
                    }
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
    }

    /// The order's stickers, and its label with them, or the order's page on the marketplace.
    private func printActions(_ order: PackOrder) -> some View {
        let key = order.items.first?.sku ?? order.saleId
        let stickers = order.items.map(StickerRequest.init)
        return HStack(spacing: Spacing.sm) {
            Button {
                printingStickers = StickerBatch(stickers: stickers)
            } label: {
                Label(stickers.count == 1 ? "Print sticker" : "Print \(stickers.count) stickers", systemImage: "qrcode")
            }
            .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
            .accessibilityIdentifier("pack.printStickers.\(key)")
            if order.label?.fileUrl != nil {
                Button {
                    printingLabel = environment.makeLabelPrint(order) { [model] changed in model.replace(changed) }
                } label: {
                    Label("Print label and stickers", systemImage: "printer")
                }
                .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
                .accessibilityIdentifier("pack.printLabel.\(key)")
            } else if let page = order.labelPageUrl.flatMap(URL.init(string:)) {
                Link(destination: page) {
                    Label("Open label on \(MarketplaceName.of(order.marketplace))", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
                .accessibilityIdentifier("pack.openLabel.\(key)")
            }
        }
    }

    /// "a label", "3 labels".
    private var readingCount: String {
        model.readingLabels == 1 ? "a label" : "\(model.readingLabels) labels"
    }

    private func start(_ orders: [PackOrder]) {
        session = PackSessionModel(orders: orders, service: environment.service) { [model] order in
            model.replace(order)
        }
    }

    private var sessionBinding: Binding<PackSessionModel?> {
        Binding(get: { session }, set: { session = $0 })
    }
}

/// Stickers to print together, for the sheet.
struct StickerBatch: Identifiable {
    let id = UUID()
    let stickers: [StickerRequest]
}

extension StickerRequest {
    /// An order's item as its sticker: its SKU, title, and shelf.
    init(_ item: PackItem) {
        self.init(sku: item.sku, title: item.title ?? item.description, locationCode: item.location?.code)
    }
}

extension LabelPrintModel: Identifiable {
    nonisolated var id: ObjectIdentifier {
        ObjectIdentifier(self)
    }
}

extension PackSessionModel: Identifiable {
    nonisolated var id: ObjectIdentifier {
        ObjectIdentifier(self)
    }
}

/// One order on the to-ship list: what to pull from the shelf, who it goes to, and its label.
struct PackOrderCard: View {
    let order: PackOrder

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            ItemPhoto(url: order.items.first?.thumbnailUrl, side: 64)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(order.items.first?.title ?? order.description)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                Text(itemLine)
                    .font(Typography.sku)
                    .foregroundStyle(Palette.textSecondary)
                Text(buyerLine)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                StatusBadge(
                    order.labelStatus.label,
                    tone: StatusTone(order.labelStatus.tone),
                    showsIcon: StatusTone(order.labelStatus.tone) != .neutral,
                )
                StatusBadge(
                    order.packStatus.label,
                    tone: StatusTone(order.packStatus.tone),
                    showsIcon: StatusTone(order.packStatus.tone) != .neutral,
                )
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A day's orders are a list: ruled, not boxed.
        .cardStyle(.ruled)
        .accessibilityElement(children: .combine)
    }

    private var itemLine: String {
        var parts: [String] = []
        if let item = order.items.first {
            parts.append(item.sku)
            if let shelf = item.location?.code {
                parts.append("Shelf \(shelf)")
            }
        }
        if order.items.count > 1 {
            parts.append("+\(order.items.count - 1) more")
        }
        return parts.joined(separator: " · ")
    }

    private var buyerLine: String {
        let marketplace = MarketplaceName.of(order.marketplace)
        return order.buyerFirstName.map { "For \($0) on \(marketplace)" } ?? "Sold on \(marketplace)"
    }
}

/// An item's photo, square, with a placeholder until it loads.
struct ItemPhoto: View {
    let url: String?
    let side: CGFloat

    var body: some View {
        RemoteImage(url: url.flatMap(URL.init(string:))) {
            Image(systemName: "photo")
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.surfaceSecondary)
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
        .accessibilityHidden(true)
    }
}

/// A marketplace's name as the seller knows it; an unknown one by its id.
enum MarketplaceName {
    static func of(_ marketplace: Components.Schemas.Marketplace) -> String {
        switch marketplace.value1 {
        case .ebay: "eBay"
        case .depop: "Depop"
        case .poshmark: "Poshmark"
        case .mercari: "Mercari"
        case nil: marketplace.value2 ?? "the marketplace"
        }
    }
}

extension StatusTone {
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}
