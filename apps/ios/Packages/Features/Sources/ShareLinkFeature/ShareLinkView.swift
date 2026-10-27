import APIClient
import Core
import DesignSystem
import SwiftUI

/// The Share Extension's screen. Light on purpose: no images, one search list, so it stays well
/// inside an extension's memory limit.
public struct ShareLinkView: View {
    @State private var model: ShareLinkModel
    private let onClose: @MainActor () -> Void

    public init(model: ShareLinkModel, onClose: @escaping @MainActor () -> Void) {
        _model = State(initialValue: model)
        self.onClose = onClose
    }

    public var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .navigationTitle("Link listing")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        .tint(Palette.brand.color)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case let .unsupported(title, message):
            EmptyStateView(
                systemImage: "link.badge.plus",
                title: title,
                message: message,
                action: .init("Close", handler: onClose),
            )
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.exclamationmark",
                title: "Sign in to Listora",
                message: "Open Listora and sign in, then share this listing again.",
                action: .init("Close", handler: onClose),
            )
        case .choosing:
            ChooseItemView(model: model)
        case let .confirming(target), let .submitting(target):
            ConfirmLinkView(model: model, target: target)
        case let .linked(linked):
            LinkedView(linked: linked, marketplace: model.listing?.marketplace, onDone: onClose)
        case let .failed(target, error):
            FailedLinkView(model: model, target: target, error: error)
        }
    }

    /// Cancel closes the extension, Back returns to choosing; the linked screen closes with its
    /// own Done button.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !isLinked {
            ToolbarItem(placement: .cancellationAction) {
                if isReviewing {
                    Button("Back") { model.back() }
                } else {
                    Button("Cancel", action: onClose)
                        .disabled(isSubmitting)
                }
            }
        }
    }

    private var isLinked: Bool {
        if case .linked = model.phase {
            true
        } else {
            false
        }
    }

    private var isReviewing: Bool {
        switch model.phase {
        case .confirming, .failed: true
        case .unsupported, .signedOut, .choosing, .submitting, .linked: false
        }
    }

    private var isSubmitting: Bool {
        if case .submitting = model.phase {
            true
        } else {
            false
        }
    }
}

/// The shared listing: marketplace and id (or "share link"), exactly what Listora read.
private struct SharedListingCard: View {
    let listing: ListingURL

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(monogram: String(listing.marketplace.displayName.prefix(1)), size: .card)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("\(listing.marketplace.displayName) listing")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(listing.listingId.map { "Listing \($0)" } ?? "Share link")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                Text(listing.canonicalURL.absoluteString)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("share.listing")
        .cardStyle()
    }
}

private struct ChooseItemView: View {
    @Bindable var model: ShareLinkModel

    var body: some View {
        List {
            if let listing = model.listing {
                Section {
                    SharedListingCard(listing: listing)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            Section {
                ScannableTextField(
                    text: $model.query,
                    placeholder: "Title, brand, or SKU",
                    accessibilityIdentifier: "share.search",
                )
                .frame(minHeight: Layout.minimumTapTarget)
                results
            } header: {
                Text("Link to an item")
            } footer: {
                if ScannableTextField.isScanningAvailable {
                    Text("Tap Scan Text to read the SKU from the item's label.")
                }
            }
            Section {
                TextField("Title", text: $model.newItemTitle, axis: .vertical)
                    .accessibilityIdentifier("share.newItemTitle")
                Button("Create item and link") { model.chooseNewItem() }
                    .disabled(model.validNewItemTitle == nil)
                    .accessibilityIdentifier("share.createItem")
            } header: {
                Text("Or create a new item")
            } footer: {
                Text("Listora creates an item with the next SKU. Add photos and details later in the app.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .task(id: model.query) {
            // Wait for typing to pause; a newer query cancels this one.
            if !model.query.isEmpty {
                try? await Task.sleep(for: .milliseconds(300))
            }
            guard !Task.isCancelled else { return }
            await model.search()
        }
    }

    private var searching: some View {
        HStack(spacing: Spacing.xs) {
            BrandSpinner()
            Text("Searching...").foregroundStyle(Palette.textSecondary)
        }
    }

    @ViewBuilder
    private var results: some View {
        switch model.searchState {
        case .idle:
            searching
        case .searching where model.results.isEmpty:
            searching
        case let .failed(error):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(error.message).foregroundStyle(Palette.danger)
                Button("Try again") { Task { await model.search() } }
            }
        case .searching, .loaded:
            if model.results.isEmpty {
                Text(model.query.isEmpty ? "No items yet." : "No items match.")
                    .foregroundStyle(Palette.textSecondary)
            }
            ForEach(model.results) { item in
                ItemRow(item: item, unavailableReason: model.unavailableReason(for: item)) {
                    model.choose(item)
                }
            }
        }
    }
}

private struct ItemRow: View {
    let item: ItemMatch
    let unavailableReason: String?
    let onChoose: @MainActor () -> Void

    var body: some View {
        Button(action: onChoose) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(item.displayTitle)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                Text(details)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                if let unavailableReason {
                    Text(unavailableReason)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.warning)
                }
            }
            .frame(maxWidth: .infinity, minHeight: Layout.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(unavailableReason != nil)
        .accessibilityIdentifier("share.item.\(item.sku)")
    }

    private var details: String {
        [item.sku, item.brand, item.sizeLabel.map { "Size \($0)" }]
            .compactMap(\.self)
            .joined(separator: " · ")
    }
}

private struct ConfirmLinkView: View {
    let model: ShareLinkModel
    let target: ShareLinkModel.Target

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                if let listing = model.listing {
                    SharedListingCard(listing: listing)
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text(heading)
                            .font(Typography.title)
                            .foregroundStyle(Palette.textPrimary)
                            .accessibilityAddTraits(.isHeader)
                        Text(
                            "You're confirming this \(listing.marketplace.displayName) listing is yours and live. "
                                + "Listora records it as confirmed by you; it does not check "
                                + "\(listing.marketplace.displayName).",
                        )
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                    }
                }
                Button("Link listing", systemImage: "link") {
                    Task { await model.confirm() }
                }
                .buttonStyle(.listoraPrimary)
                .loading(isSubmitting)
                .accessibilityIdentifier("share.confirm")
            }
            .padding(Spacing.md)
        }
    }

    private var heading: String {
        switch target {
        case let .existing(item): "Link to \(item.sku)?"
        case let .newItem(title): "Create “\(title)” and link?"
        }
    }

    private var isSubmitting: Bool {
        if case .submitting = model.phase {
            true
        } else {
            false
        }
    }
}

private struct LinkedView: View {
    let linked: LinkedListing
    let marketplace: ListingMarketplace?
    let onDone: @MainActor () -> Void

    var body: some View {
        VStack(spacing: Spacing.md) {
            IconTile(systemImage: "link", tone: linked.statusTone == .success ? .success : nil, size: .hero)
            Text("Linked to \(linked.itemSKU)")
                .font(Typography.title)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("share.linked")
            if let title = linked.itemTitle {
                Text(title)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
            }
            StatusBadge(
                [marketplace?.displayName, linked.statusLabel].compactMap(\.self).joined(separator: ": "),
                tone: linked.statusTone,
            )
            .accessibilityIdentifier("share.status")
            Button("Done", action: onDone)
                .buttonStyle(.listoraPrimary)
                .padding(.top, Spacing.xs)
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FailedLinkView: View {
    let model: ShareLinkModel
    let target: ShareLinkModel.Target
    let error: APIFailure

    var body: some View {
        VStack(spacing: Spacing.md) {
            IconTile(systemImage: "exclamationmark.triangle", tone: .failed, size: .hero)
            Text("Not linked")
                .font(Typography.title)
                .foregroundStyle(Palette.textPrimary)
            Text(error.message)
                .font(Typography.body)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("share.error")
            if error.retryable {
                Button("Try again") { Task { await model.retry() } }
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("share.retry")
            }
            Button("Choose another item") { model.back() }
                .buttonStyle(.listoraTertiary)
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
