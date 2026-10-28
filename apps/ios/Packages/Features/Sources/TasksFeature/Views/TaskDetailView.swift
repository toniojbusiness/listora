import DesignSystem
import SwiftUI

/// One task, as numbered steps: save the photos in order, copy the details, open the marketplace,
/// then confirm. A delist opens the exact listing and ends with "Done - I removed it". Done is the
/// user's word, and the listing then reads "Done (you confirmed)", never "confirmed by" the
/// marketplace.
struct TaskDetailView: View {
    @State private var model: TaskDetailModel
    private let onFinished: (TaskDetailModel.Outcome) -> Void
    @State private var toast: Toast?
    @State private var confirmsDismiss = false
    @Environment(\.openURL) private var openURL

    init(model: TaskDetailModel, onFinished: @escaping (TaskDetailModel.Outcome) -> Void) {
        _model = State(initialValue: model)
        self.onFinished = onFinished
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                TaskHeader(task: model.task, presentation: model.presentation)
                if let problem = model.problem {
                    Banner(problem, tone: .failed, identifier: "task.problem")
                }
                if let offer = model.offer {
                    OfferTaskView(model: offer, open: open)
                }
                steps
            }
            .padding(Spacing.md)
        }
        .background(Palette.background)
        .navigationTitle(model.presentation.marketplaceName)
        .navigationBarTitleDisplayMode(.inline)
        .bottomActionBar { actions }
        .toast($toast)
        .confirmationDialog("Dismiss this task?", isPresented: $confirmsDismiss, titleVisibility: .visible) {
            Button("Dismiss task", role: .destructive) {
                Task { await model.dismiss() }
            }
            .accessibilityIdentifier("task.dismiss.confirm")
            Button("Keep it", role: .cancel) {}
        } message: {
            Text(model.presentation.dismissMessage)
        }
        .onChange(of: model.outcome) { _, outcome in
            if let outcome {
                onFinished(outcome)
            }
        }
    }

    @ViewBuilder
    private var steps: some View {
        let presentation = model.presentation
        if presentation.kind == .unknown {
            Banner(
                "Update Listora to finish this task",
                message: "This version of the app doesn't know this kind of task yet.",
                tone: .actionNeeded,
            )
        }
        let steps = presentation.steps(
            hasPhotos: !model.photos.isEmpty,
            hasFields: !model.fields.isEmpty,
            hasLink: model.deepLink != nil,
        )
        ForEach(Array(steps.enumerated()), id: \.element) { index, step in
            self.step(step, number: index + 1)
        }
    }

    @ViewBuilder
    private func step(_ step: TaskPresentation.Step, number: Int) -> some View {
        let name = model.presentation.marketplaceName
        switch step {
        case .savePhotos:
            PhotosStep(number: number, model: model)
        case .copyDetails:
            CopyStep(number: number, fields: model.fields) { field in
                toast = Toast(model.copy(field))
            }
        case let .open(title):
            OpenStep(
                number: number,
                title: title,
                buttonTitle: model.presentation.openTitle,
                url: model.deepLink,
                open: open,
            )
        case .pasteLink:
            LinkStep(number: number, model: model)
        case .removeListing:
            StepCard(number: number, title: "Delete it or mark it sold") {
                Text("Do it in the \(name) app or site. Listora can't check \(name) for you, so it goes by your word.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .saleEmail:
            if let email = model.task.saleEmail {
                SaleEmailStep(number: number, email: email, marketplaceName: name)
            }
        case .pickItem:
            PickItemStep(number: number, model: model)
        }
    }

    @ViewBuilder
    private var actions: some View {
        if let offer = model.offer {
            OfferTaskView(model: offer, open: open).actions
            HStack(spacing: Spacing.sm) {
                OfferTaskView(model: offer, open: open).declineAction
                dismissButton
            }
        }
        if let doneTitle = model.presentation.doneTitle {
            Button(doneTitle, systemImage: "checkmark") {
                Task { await model.complete() }
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isSubmitting)
            .disabled(model.linkProblem != nil)
            .accessibilityIdentifier("task.done")
        }
        if let rejectTitle = model.presentation.rejectTitle {
            Button(rejectTitle, systemImage: "xmark") {
                Task { await model.rejectMatch() }
            }
            .buttonStyle(.listoraSecondary)
            .loading(model.isSubmitting)
            .accessibilityIdentifier("task.rejectMatch")
        }
        if model.offer == nil {
            dismissButton
        }
    }

    private var dismissButton: some View {
        Button(model.offer == nil ? "Dismiss task" : "Hide this offer") { confirmsDismiss = true }
            .buttonStyle(.listora(.destructiveText, size: .large))
            .disabled(model.isSubmitting)
            .accessibilityIdentifier("task.dismiss")
    }

    private func open(_ url: URL) {
        openURL(url)
    }
}

/// The task's title, its item, urgency, and the server's instructions.
private struct TaskHeader: View {
    let task: UserTask
    let presentation: TaskPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                TaskThumbnail(task: task, presentation: presentation)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("task.title")
                    if let item = task.item {
                        Text([item.title, item.sku].compactMap(\.self).joined(separator: " · "))
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            if presentation.isUrgent {
                StatusBadge("Urgent - an item sold", tone: .failed)
                    .accessibilityIdentifier("task.urgent")
            }
            if let instructions = task.instructions {
                Text(instructions)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A numbered step on a card.
struct StepCard<Content: View>: View {
    let number: Int
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Text("\(number)")
                    .font(Typography.label)
                    .foregroundStyle(Palette.brand)
                    .frame(minWidth: 24, minHeight: 24)
                    .background(Palette.brandSoft, in: Circle())
                    .accessibilityHidden(true)
                Text(title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityLabel("Step \(number): \(title)")
            }
            content
        }
        .cardStyle()
    }
}

/// The photos in posting order, and saving them to the camera roll in that order.
private struct PhotosStep: View {
    let number: Int
    let model: TaskDetailModel

    var body: some View {
        StepCard(number: number, title: "Save the photos") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach(Array(model.photos.enumerated()), id: \.element.id) { index, photo in
                        RemoteImage(url: (photo.urls?.thumbnail).flatMap(URL.init(string:))) {
                            Palette.surfaceSecondary.color
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        .overlay(alignment: .topLeading) {
                            Text("\(index + 1)")
                                .font(Typography.label)
                                .foregroundStyle(Palette.onBrand)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Palette.brand, in: Capsule())
                                .padding(4)
                        }
                        .accessibilityLabel("Photo \(index + 1) of \(model.photos.count)")
                    }
                }
            }
            Button(saveTitle, systemImage: "square.and.arrow.down") {
                Task { await model.savePhotos() }
            }
            .buttonStyle(.listoraSecondary)
            .loading(isSaving)
            .accessibilityIdentifier("task.savePhotos")
            status
        }
    }

    private var isSaving: Bool {
        if case .saving = model.photoState {
            true
        } else {
            false
        }
    }

    private var saveTitle: String {
        let count = model.photos.count
        return "Save \(count) \(count == 1 ? "photo" : "photos") to Camera Roll"
    }

    @ViewBuilder
    private var status: some View {
        switch model.photoState {
        case .idle:
            Text("They're saved in posting order, so pick them in the same order in the app.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        case let .saving(saved, total):
            StatusLabel("Saving \(saved) of \(total)...", tone: .inProgress)
        case let .saved(count):
            StatusLabel("Saved \(count) \(count == 1 ? "photo" : "photos") in order", tone: .success)
                .accessibilityIdentifier("task.photosSaved")
        case let .failed(message):
            StatusLabel(message, tone: .failed)
                .accessibilityIdentifier("task.photosFailed")
        }
    }
}

/// The details to paste, each copied with one tap.
private struct CopyStep: View {
    let number: Int
    let fields: [CopyField]
    let copy: (CopyField) -> Void

    var body: some View {
        StepCard(number: number, title: "Copy the details") {
            VStack(spacing: 0) {
                ForEach(Array(fields.enumerated()), id: \.element.id) { index, field in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color)
                    }
                    HStack(alignment: .center, spacing: Spacing.sm) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.label)
                                .font(Typography.caption)
                                .foregroundStyle(Palette.textSecondary)
                            Text(field.value)
                                .font(Typography.body)
                                .foregroundStyle(Palette.textPrimary)
                                .lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Copy", systemImage: "doc.on.doc") { copy(field) }
                            .buttonStyle(.listora(.secondary, size: .compact))
                            .accessibilityLabel("Copy \(field.label.lowercased())")
                            .accessibilityIdentifier("task.copy.\(field.label.lowercased())")
                    }
                    .padding(.vertical, Spacing.xs)
                }
            }
        }
    }
}

/// Opens the marketplace's app or site, or the listing itself.
private struct OpenStep: View {
    let number: Int
    let title: String
    let buttonTitle: String
    let url: URL?
    let open: (URL) -> Void

    var body: some View {
        StepCard(number: number, title: title) {
            if let url {
                Button(buttonTitle, systemImage: "arrow.up.right.square") { open(url) }
                    .buttonStyle(.listoraSecondary)
                    .accessibilityIdentifier("task.open")
                Text(url.host() ?? url.absoluteString)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            } else {
                Text("Open the marketplace's app yourself; Listora has no link for this step.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
    }
}

/// The new listing's link, pasted here or shared from the marketplace's app, so later changes
/// open the listing itself.
private struct LinkStep: View {
    let number: Int
    @Bindable var model: TaskDetailModel

    var body: some View {
        StepCard(number: number, title: "Paste the listing's link") {
            ListoraTextField(
                "Listing link (optional)",
                hint: "Or share the listing from the \(model.presentation.marketplaceName) app to Listora.",
                error: model.linkProblem,
            ) {
                TextField(
                    "Listing link",
                    text: $model.listingURL,
                    prompt: Text("https://").foregroundStyle(Palette.textSecondary),
                )
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .accessibilityIdentifier("task.link")
            }
            PasteButton(payloadType: String.self) { [model] strings in
                guard let pasted = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                Task { @MainActor in model.listingURL = pasted }
            }
            .buttonBorderShape(.roundedRectangle)
            .tint(Palette.brand.color)
            .labelStyle(.titleAndIcon)
        }
    }
}
