import Core
import DesignSystem
import SwiftUI

/// The confidence-first review: the details that need a look first, then the rest by section,
/// each editable in place, then the listing copy per marketplace. The bottom bar holds the talk
/// button for spoken corrections and "Next to check".
struct ReviewFormView: View {
    @Bindable var model: ReviewFlowModel
    let voice: VoiceCorrectionModel
    @State private var editingCopy: MarketplaceCopy?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if let form = model.form {
            ScrollViewReader { proxy in
                ScrollView {
                    // Not lazy: "Next" scrolls to rows anywhere in the review, loaded or not.
                    VStack(alignment: .leading, spacing: Spacing.lg) {
                        ReviewHeader(model: model)
                        identifyHarder
                        ForEach(form.sections, id: \.section) { entry in
                            section(entry.section, keys: entry.keys, form: form)
                        }
                        copySection
                    }
                    .padding(Spacing.md)
                    .frame(maxWidth: Layout.readableWidth)
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("review.scroll")
                .onChange(of: model.focusedField) { _, key in
                    if let key {
                        withAnimation { proxy.scrollTo(key, anchor: .center) }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .bottomActionBar { continueBar(form) }
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
        let isAttention = section == .attention
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            sectionHeader(section, count: keys.count)
            VStack(spacing: 0) {
                ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color).padding(.leading, Spacing.md)
                    }
                    FieldRow(
                        field: form.field(key),
                        draftText: draftText(key),
                        isFocused: model.focusedField == key,
                        onEdit: {
                            model.focusedField = nil
                            model.beginEditing(key)
                        },
                        onSelect: { value in
                            model.focusedField = nil
                            model.update(key, to: value)
                        },
                        onCommit: { model.commitEditing(key) },
                        onQuickPick: { option in
                            model.focusedField = nil
                            model.choose(option)
                        },
                        onNext: { model.advanceToNextCheck(after: key) },
                    )
                    .id(key)
                }
            }
            .background(Palette.surface, in: shape)
            .clipShape(shape)
            .overlay(
                shape.strokeBorder(isAttention ? Palette.warning : Palette.separator, lineWidth: isAttention ? 1.5 : 1),
            )
        }
    }

    /// "Check these (2)" with what it means, or the section's small-capitals title.
    @ViewBuilder
    private func sectionHeader(_ section: ReviewSection, count: Int) -> some View {
        if section == .attention {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Label {
                    Text("\(section.title) (\(count))")
                        .accessibilityIdentifier("review.section.attention")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
                }
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)
                Text("Listora is less sure about these, or they're missing. Fix them and the rest is done.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        } else {
            SectionHeader(section.title)
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
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader(
                    "On each marketplace",
                    subtitle: "Listora wrote a title and description for each one. Tap one to change it.",
                )
                VStack(spacing: 0) {
                    ForEach(Array(model.copies.enumerated()), id: \.element.id) { index, copy in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color).padding(.leading, Spacing.md)
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
                .cardStyle(.outlined, padding: 0)
            }
        }
    }

    @ViewBuilder
    private func continueBar(_ form: ReviewForm) -> some View {
        let missing = form.missing
        let toCheck = model.fieldsToCheck.count
        if voice.hasContent || voice.isListening {
            VoiceTray(voice: voice)
        }
        // At accessibility sizes the controls stack, so "Hold to talk" and "Next" read whole.
        let controls = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
            : AnyLayout(HStackLayout(spacing: Spacing.xs))
        controls {
            TalkButton(voice: voice)
            Button("Type", systemImage: "keyboard") {
                voice.showsTyping.toggle()
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.listora(.tertiary, size: .compact))
            .accessibilityLabel(voice.showsTyping ? "Hide the typing field" : "Type a correction")
            .accessibilityIdentifier("voice.type")
            if !dynamicTypeSize.isAccessibilitySize {
                Spacer(minLength: 0)
            }
            if toCheck > 0 {
                Button("Next (\(toCheck))", systemImage: "arrow.right.circle") {
                    model.advanceToNextCheck()
                }
                .buttonStyle(.listora(.tertiary, size: .compact))
                .lineLimit(1)
                .accessibilityLabel("Next to check, \(toCheck) left")
                .accessibilityIdentifier("review.nextToCheck")
            }
        }
        if !missing.isEmpty {
            Label(
                "Add \(missing.map(\.inlineTitle).formatted(.list(type: .and))) to continue.",
                systemImage: "exclamationmark.triangle.fill",
            )
            .font(Typography.footnote.weight(.semibold))
            .foregroundStyle(Palette.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("review.missing")
        }
        Button("Continue to cost") {
            Task { await model.continueToCost() }
        }
        .buttonStyle(.listoraPrimary)
        .loading(model.isWorking)
        .disabled(!missing.isEmpty || model.escalation == .running || voice.isListening || voice.phase == .interpreting)
        .accessibilityIdentifier("review.continue")
    }
}

/// The cover photo and title at the top of the review.
struct ReviewHeader: View {
    let model: ReviewFlowModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // Side by side, or the photo above the title at accessibility sizes.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
            : AnyLayout(HStackLayout(spacing: Spacing.sm))
        layout {
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
            .frame(width: 72, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                    .strokeBorder(Palette.separator, lineWidth: 1),
            )
            .accessibilityHidden(true)
            // The SKU is the screen's title.
            Text(model.form?.field(.title).displayValue ?? "")
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        switch emphasis {
        case let .prominent(reason):
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
                : AnyLayout(HStackLayout(alignment: .top, spacing: Spacing.sm))
            VStack(alignment: .leading, spacing: Spacing.sm) {
                layout {
                    IconTile(systemImage: "sparkle.magnifyingglass", size: .card)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(reason)
                            .font(Typography.headline)
                            .foregroundStyle(Palette.textPrimary)
                        Text("A premium identification takes a closer look at the brand, product, and era.")
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Continue is the screen's one primary action.
                button.buttonStyle(.listoraSecondary)
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
                    ProgressView().tint(Palette.brand.color)
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
            Label(
                canRetry && !isUsedUp ? "\(message) Tap Identify harder to try again." : message,
                systemImage: StatusTone.failed.systemImage,
            )
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
            .accessibilityIdentifier("review.identifyHarderProblem")
        default:
            Text(quotaLine)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("review.premiumQuota")
        }
    }
}

/// One marketplace's copy in the review: its title and whether the seller edited it.
struct CopyRow: View {
    let copy: MarketplaceCopy

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(monogram: String(copy.name.prefix(1)))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                HStack(spacing: Spacing.xs) {
                    Text(copy.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    if copy.edited != nil {
                        Chip("Edited", systemImage: "pencil", prominent: true)
                    }
                }
                Text(copy.hasTitle ? copy.current.title : copy.current.description)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(2)
                if let problem = copy.problems.first {
                    Label(problem, systemImage: StatusTone.failed.systemImage)
                        .font(Typography.footnote.weight(.semibold))
                        .foregroundStyle(Palette.danger)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(Typography.footnote.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .frame(minHeight: 36)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edits the copy for \(copy.name)")
    }
}
