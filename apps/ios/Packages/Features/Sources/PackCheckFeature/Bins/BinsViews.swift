import Core
import DesignSystem
import SwiftUI

/// Settings > Storage bins (docs/features/storage-bins.md): every bin with how many items are in
/// it, and New bin with the next code filled in. A bin opens on what is in it and its sticker.
struct BinsView: View {
    let environment: PackCheckEnvironment
    @State private var model: BinsModel
    @State private var form: BinFormModel?

    init(environment: PackCheckEnvironment) {
        self.environment = environment
        _model = State(initialValue: BinsModel(service: environment.bins))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Storage bins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("New bin", systemImage: "plus") { form = model.makeForm() }
                        .disabled(model.phase != .loaded)
                        .accessibilityIdentifier("bins.new")
                }
            }
            .sheet(item: $form) { form in
                BinFormView(model: form)
            }
            .task { await model.load() }
            .refreshable { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 4, label: "Loading your bins")
        case let .failed(message):
            EmptyStateView(
                systemImage: "archivebox",
                tone: .failed,
                title: "Bins unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded where model.bins.isEmpty:
            EmptyStateView(
                systemImage: "archivebox",
                title: "No bins yet",
                message: "Make a bin for each box or shelf, print its sticker, and scan it to put items in. "
                    + "Each sale then says where to find the item.",
                action: .init("Make bin \(model.nextCode)", systemImage: "plus") { form = model.makeForm() },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    VStack(spacing: 0) {
                        ForEach(Array(model.bins.enumerated()), id: \.element.id) { index, bin in
                            if index > 0 {
                                Divider().overlay(Palette.separator.color)
                            }
                            NavigationLink {
                                BinDetailView(environment: environment, binID: bin.id) {
                                    Task { await model.load() }
                                }
                            } label: {
                                BinRow(bin: bin)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("bins.bin.\(bin.code)")
                        }
                    }
                    .cardStyle(.flat, padding: 0)
                    Text("Scan a bin's sticker from an item's screen to put the item in it.")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// A bin in a list: its code as on its sticker, where it is, and how many items it holds.
struct BinRow: View {
    let bin: Bin
    var isCurrent = false

    var body: some View {
        HStack(spacing: Spacing.sm) {
            IconTile(systemImage: "archivebox", tone: isCurrent ? .success : nil, size: .row)
            VStack(alignment: .leading, spacing: 2) {
                Text(bin.code)
                    .font(Typography.number)
                    .foregroundStyle(Palette.textPrimary)
                if let label = bin.label {
                    Text(label)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: Spacing.sm)
            Text(bin.itemCount == 1 ? "1 item" : "\(bin.itemCount) items")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(Palette.brand.color)
                    .accessibilityLabel("Its bin now")
            }
        }
        .padding(Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Making or renaming a bin: the code on its sticker, and where it is.
struct BinFormView: View {
    @Bindable var model: BinFormModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    ListoraTextField("Code", hint: "On the bin's sticker, such as B-12.") {
                        TextField("B-12", text: $model.code)
                            .font(Typography.code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("binForm.code")
                    }
                    ListoraTextField("Where it is", hint: "Optional, such as Garage shelf 3.") {
                        TextField("Garage shelf 3", text: $model.label)
                            .accessibilityIdentifier("binForm.label")
                    }
                    if model.editing != nil {
                        Text("A sticker printed with the old code won't scan as this bin. Print a new one.")
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    if let failure = model.failure {
                        Banner("Not saved", message: failure, tone: .failed, identifier: "binForm.failure")
                    }
                }
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .navigationTitle(model.editing == nil ? "New bin" : "Rename bin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.save() {
                                dismiss()
                            }
                        }
                    }
                    .disabled(!model.canSave)
                    .accessibilityIdentifier("binForm.save")
                }
            }
            .interactiveDismissDisabled(model.isSaving)
        }
        .presentationDetents([.medium, .large])
    }
}

/// One bin: what is in it, its sticker, renaming it, and deleting it.
struct BinDetailView: View {
    let environment: PackCheckEnvironment
    @State private var model: BinDetailModel
    @State private var form: BinFormModel?
    @State private var printing: StickerRequest?
    @State private var confirmsDelete = false
    @Environment(\.dismiss) private var dismiss

    init(environment: PackCheckEnvironment, binID: String, onChange: @escaping @MainActor () -> Void) {
        self.environment = environment
        _model = State(initialValue: BinDetailModel(binID: binID, service: environment.bins, onChange: onChange))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle(model.detail.map { "Bin \($0.location.code)" } ?? "Bin")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $form) { BinFormView(model: $0) }
            .sheet(item: $printing) { StickerPrintView(stickers: [$0]) }
            .confirmationDialog(
                "Delete this bin?",
                isPresented: $confirmsDelete,
                titleVisibility: .visible,
            ) {
                Button("Delete bin", role: .destructive) { Task { await model.delete() } }
            } message: {
                Text("Its items stay in your inventory, in no bin.")
            }
            .task { await model.load() }
            .refreshable { await model.load() }
            .onChange(of: model.phase) { _, phase in
                if phase == .gone {
                    dismiss()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 3, label: "Loading the bin")
        case let .failed(message):
            EmptyStateView(
                systemImage: "archivebox",
                tone: .failed,
                title: "Bin unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .gone:
            EmptyStateView(
                systemImage: "archivebox",
                title: "Bin deleted",
                message: "Its items are still in your inventory.",
            )
        case .loaded:
            if let detail = model.detail {
                loaded(detail)
            }
        }
    }

    private func loaded(_ detail: BinDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(detail.location.code)
                        .font(Typography.priceLarge)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityIdentifier("bin.code")
                    if let label = detail.location.label {
                        Text(label)
                            .font(Typography.body)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                if let failure = model.failure {
                    Banner(
                        "That didn't go through",
                        message: failure,
                        tone: .failed,
                        onDismiss: { model.failure = nil },
                    )
                }
                Button("Print bin sticker", systemImage: "qrcode") {
                    printing = StickerRequest(binCode: detail.location.code, label: detail.location.label)
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("bin.printSticker")
                items(of: detail)
                HStack(spacing: Spacing.sm) {
                    Button("Rename") { form = model.makeRenameForm() }
                        .buttonStyle(.listoraSecondary)
                        .accessibilityIdentifier("bin.rename")
                    Button("Delete bin", role: .destructive) { confirmsDelete = true }
                        .buttonStyle(.listora(.destructiveText, size: .compact))
                        .accessibilityIdentifier("bin.delete")
                }
                .disabled(model.isWorking)
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func items(of detail: BinDetail) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(
                detail.location.itemCount == 1 ? "1 item" : "\(detail.location.itemCount) items",
                subtitle: "Sold items leave the bin.",
            )
            if detail.items.isEmpty {
                Text("Nothing in it yet. Scan this bin's sticker from an item's screen to put the item in.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .cardStyle(.flat)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(detail.items.enumerated()), id: \.element.itemId) { index, item in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color)
                        }
                        itemRow(item)
                    }
                }
                .cardStyle(.flat, padding: 0)
            }
        }
    }

    private func itemRow(_ item: BinItem) -> some View {
        HStack(spacing: Spacing.sm) {
            ItemPhoto(url: item.thumbnailUrl, side: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title ?? "Untitled item")
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(1)
                Text(item.sku)
                    .font(Typography.sku)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            Button("Take out") { Task { await model.takeOut(itemID: item.itemId) } }
                .buttonStyle(.listora(.tertiary, size: .compact))
                .disabled(model.isWorking)
                .accessibilityIdentifier("bin.takeOut.\(item.sku)")
        }
        .padding(Spacing.sm)
    }
}
