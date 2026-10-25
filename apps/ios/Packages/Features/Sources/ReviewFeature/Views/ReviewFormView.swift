import Core
import DesignSystem
import SwiftUI

/// The confidence-first review: the details that need a look first, then the rest by section,
/// each editable in place, then the listing copy per marketplace.
struct ReviewFormView: View {
    @Bindable var model: ReviewFlowModel
    @State private var editingCopy: MarketplaceCopy?

    var body: some View {
        if let form = model.form {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Spacing.lg) {
                    ReviewHeader(model: model)
                    identifyHarder
                    ForEach(form.sections, id: \.section) { entry in
                        section(entry.section, keys: entry.keys, form: form)
                    }
                    copySection
                }
                .padding(Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { continueBar(form) }
            .sheet(item: $editingCopy) { copy in
                CopyEditorView(copy: copy) { model.saveCopy($0, for: copy.marketplace) }
            }
        }
    }

    @ViewBuilder
    private var identifyHarder: some View {
        if let emphasis = model.identifyHarder {
            IdentifyHarderView(
                emphasis: emphasis,
                escalation: model.escalation,
                quotaLine: model.premiumQuotaLine,
                isUsedUp: model.isPremiumQuotaUsedUp,
                onStart: { Task { await model.startIdentifyHarder() } },
            )
        } else if model.escalation == .finished {
            Label("Identified with premium identification", systemImage: "checkmark.seal.fill")
                .font(Typography.callout)
                .foregroundStyle(Palette.success)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("review.premiumDone")
        }
    }

    private func section(_ section: ReviewSection, keys: [ReviewFieldKey], form: ReviewForm) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(section == .attention ? "\(section.title) (\(keys.count))" : section.title)
                    .font(Typography.headline)
                    .foregroundStyle(section == .attention ? Palette.warning : Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("review.section.\(section.rawValue)")
                if section == .attention {
                    Text("Lower confidence or missing. Fix these and the rest is done.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            VStack(spacing: 0) {
                ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color)
                    }
                    FieldRow(
                        field: form.field(key),
                        draftText: draftText(key),
                        onEdit: { model.beginEditing(key) },
                        onSelect: { value in model.update(key, to: value) },
                        onCommit: { model.commitEditing(key) },
                    )
                }
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                    .strokeBorder(section == .attention ? Palette.warning : Palette.separator, lineWidth: 1),
            )
        }
    }

    /// The text typed in `key`'s editor, when it is the open one.
    private func draftText(_ key: ReviewFieldKey) -> Binding<String>? {
        guard model.editing?.key == key else { return nil }
        return Binding(
            get: { model.editing?.text ?? "" },
            set: { text in
                if model.editing?.key == key {
                    model.editing?.text = text
                }
            },
        )
    }

    @ViewBuilder
    private var copySection: some View {
        if !model.copies.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("On each marketplace")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                VStack(spacing: 0) {
                    ForEach(Array(model.copies.enumerated()), id: \.element.id) { index, copy in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color)
                        }
                        Button {
                            editingCopy = copy
                        } label: {
                            CopyRow(copy: copy)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("review.copy.\(copy.marketplace)")
                    }
                }
                .cardBackground()
            }
        }
    }

    private func continueBar(_ form: ReviewForm) -> some View {
        let missing = form.missing
        return VStack(spacing: Spacing.xs) {
            if !missing.isEmpty {
                Text("Add \(missing.map { $0.title.lowercased() }.formatted(.list(type: .and))) to continue.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
                    .accessibilityIdentifier("review.missing")
            }
            Button {
                Task { await model.continueToCost() }
            } label: {
                if model.isWorking {
                    ProgressView().tint(Palette.onBrand.color)
                } else {
                    Text("Continue")
                }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(!missing.isEmpty || model.isWorking || model.escalation == .running)
            .accessibilityIdentifier("review.continue")
        }
        .bottomBar()
    }
}

/// The cover photo and title at the top of the review.
struct ReviewHeader: View {
    let model: ReviewFlowModel

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Group {
                if let url = model.item?.photos.first?.urls.flatMap({ URL(string: $0.thumbnail) }) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Palette.surfaceSecondary.color
                    }
                } else {
                    Palette.surfaceSecondary.color
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .accessibilityHidden(true)
            // The SKU is the screen's title.
            Text(model.form?.field(.title).displayValue ?? "")
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Identify harder": prominent when the brand is missing or uncertain, with what it costs from
/// the plan's premium identifications.
struct IdentifyHarderView: View {
    let emphasis: IdentifyHarderEmphasis
    let escalation: ReviewFlowModel.Escalation
    let quotaLine: String
    let isUsedUp: Bool
    let onStart: () -> Void

    var body: some View {
        switch emphasis {
        case let .prominent(reason):
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Label(reason, systemImage: "questionmark.circle.fill")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text("A premium identification takes a closer look at the brand, product, and era.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                button.buttonStyle(.listoraPrimary)
                status
            }
            .cardStyle()
        case .available:
            VStack(alignment: .leading, spacing: Spacing.xs) {
                button.buttonStyle(.listoraSecondary)
                status
            }
        }
    }

    private var button: some View {
        Button(action: onStart) {
            if escalation == .running {
                HStack(spacing: Spacing.xs) {
                    ProgressView()
                    Text("Identifying harder")
                }
            } else {
                Label("Identify harder", systemImage: "sparkle.magnifyingglass")
            }
        }
        .disabled(escalation == .running || isUsedUp)
        .accessibilityIdentifier("review.identifyHarder")
    }

    @ViewBuilder
    private var status: some View {
        switch escalation {
        case let .failed(message, canRetry):
            Text(canRetry && !isUsedUp ? "\(message) Tap Identify harder to try again." : message)
                .font(Typography.caption)
                .foregroundStyle(Palette.danger)
                .accessibilityIdentifier("review.identifyHarderProblem")
        default:
            Text(quotaLine)
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("review.premiumQuota")
        }
    }
}

/// One marketplace's copy in the review: its title and whether the seller edited it.
struct CopyRow: View {
    let copy: MarketplaceCopy

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                HStack(spacing: Spacing.xs) {
                    Text(copy.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    if copy.edited != nil {
                        Text("Edited")
                            .font(Typography.caption.weight(.semibold))
                            .foregroundStyle(Palette.brand)
                    }
                }
                Text(copy.hasTitle ? copy.current.title : copy.current.description)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(2)
                if let problem = copy.problems.first {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(Typography.caption.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .accessibilityHidden(true)
        }
        .padding(Spacing.md)
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edits the copy for \(copy.name)")
    }
}

extension View {
    /// The bar under a screen's content that holds its main action.
    func bottomBar() -> some View {
        padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(Palette.background)
            .overlay(alignment: .top) {
                Divider().overlay(Palette.separator.color)
            }
    }

    /// The card surface without the card's padding, for lists of rows.
    func cardBackground() -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        return background(Palette.surface, in: shape)
            .overlay(shape.strokeBorder(Palette.separator, lineWidth: 1))
    }
}
