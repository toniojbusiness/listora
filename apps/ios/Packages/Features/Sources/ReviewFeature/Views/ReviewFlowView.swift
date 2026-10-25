import Core
import DesignSystem
import SwiftUI

/// The first screen of the flow: progress while the photos are processed and analyzed, a failure
/// the seller can retry, then the review. The cost, price, and saved screens push from here.
struct ReviewFlowView: View {
    let onFinished: @MainActor (ItemReviewOutcome) -> Void
    @State private var model: ReviewFlowModel
    @State private var voice: VoiceCorrectionModel

    init(
        environment: ReviewEnvironment,
        request: ItemReviewRequest,
        onFinished: @escaping @MainActor (ItemReviewOutcome) -> Void,
    ) {
        self.onFinished = onFinished
        let model = environment.makeModel(for: request)
        _model = State(initialValue: model)
        _voice = State(initialValue: VoiceCorrectionModel(target: model, transcriber: environment.transcriber))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle(model.item?.sku ?? model.request.sku ?? "Review")
            .navigationBarTitleDisplayMode(.inline)
            // The flow has its own bottom bars; the tabs come back when it ends.
            .toolbar(.hidden, for: .tabBar)
            .task { await model.appeared() }
            .measuresInteraction(model)
            .actionErrorAlert(model)
            .navigationDestination(isPresented: $model.showsCost) {
                CostView(model: model, onFinished: onFinished)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading, .preparingPhotos, .analyzing:
            AnalysisProgressView(phase: model.phase)
        case let .failed(problem):
            ProblemView(
                problem: problem,
                onRetry: { Task { await model.start() } },
                onEditPhotos: { onFinished(.editPhotos) },
                onGoBack: { onFinished(.back) },
            )
        case .reviewing:
            ReviewFormView(model: model, voice: voice)
        case .alreadySaved:
            if let saved = model.saved {
                SavedItemView(saved: saved, onDone: { onFinished(.saved(sku: saved.sku)) })
            }
        }
    }
}

/// What the server is doing for the item, step by step, so a wait never looks stuck.
struct AnalysisProgressView: View {
    let phase: ReviewFlowModel.Phase

    var body: some View {
        CenteredScroll {
            VStack(spacing: Spacing.lg) {
                IconTile(systemImage: "sparkles", size: .hero)
                VStack(spacing: Spacing.xs) {
                    Text(title)
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(detail)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .multilineTextAlignment(.center)
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    step("Photos uploaded", state: .done)
                    step(photosStep, state: photosState)
                    step("Reading the tags and photos", state: analysisState)
                }
                .cardStyle()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("review.progress")
    }

    private enum StepState {
        case waiting
        case running
        case done
    }

    private var title: String {
        switch phase {
        case .analyzing(slow: true): "Still working on it"
        case .analyzing: "Identifying your item"
        default: "Getting your photos ready"
        }
    }

    private var detail: String {
        switch phase {
        case .analyzing(slow: true):
            "This is taking longer than usual. Listora keeps going and shows the details as soon as they're ready."
        default:
            "Listora reads the tags and photos once, then fills in the details for you to check."
        }
    }

    private var photosStep: String {
        if case let .preparingPhotos(ready, total) = phase {
            return "Preparing photos (\(ready) of \(total))"
        }
        return "Preparing photos"
    }

    private var photosState: StepState {
        switch phase {
        case .loading, .preparingPhotos: .running
        default: .done
        }
    }

    private var analysisState: StepState {
        if case .analyzing = phase {
            return .running
        }
        return .waiting
    }

    private func step(_ text: String, state: StepState) -> some View {
        HStack(spacing: Spacing.sm) {
            Group {
                switch state {
                case .done:
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
                case .running:
                    ProgressView().controlSize(.small).tint(Palette.info.color)
                case .waiting:
                    Image(systemName: "circle").foregroundStyle(Palette.textSecondary)
                }
            }
            .font(Typography.headline)
            .frame(width: 24, height: 24)
            .accessibilityHidden(true)
            Text(text)
                .font(state == .running ? Typography.body.weight(.semibold) : Typography.body)
                .foregroundStyle(state == .waiting ? Palette.textSecondary : Palette.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(state == .done ? "Done" : state == .running ? "In progress" : "Waiting")
    }
}

/// Why the flow stopped, with what the seller can do about it in the bottom bar.
struct ProblemView: View {
    let problem: ReviewFlowModel.Problem
    let onRetry: () -> Void
    let onEditPhotos: () -> Void
    let onGoBack: () -> Void

    var body: some View {
        CenteredScroll {
            VStack(spacing: Spacing.lg) {
                IconTile(systemImage: "exclamationmark.triangle.fill", tone: .failed, size: .hero)
                VStack(spacing: Spacing.xs) {
                    Text(problem.title)
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(problem.message)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("review.problem")
                }
                .multilineTextAlignment(.center)
            }
        }
        .bottomActionBar {
            if problem.canRetry {
                Button("Try again", systemImage: "arrow.clockwise", action: onRetry)
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("review.retry")
            }
            if problem.suggestsEditingPhotos {
                Button("Edit photos", systemImage: "photo.on.rectangle", action: onEditPhotos)
                    .buttonStyle(problem.canRetry ? .listoraSecondary : .listoraPrimary)
                    .accessibilityIdentifier("review.editPhotos")
            } else if !problem.canRetry {
                Button("Go back", action: onGoBack)
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("review.goBack")
            }
        }
    }
}

/// Content centered on the screen when it fits, scrolling from the top when large text makes it
/// taller, at a readable width.
struct CenteredScroll<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                content
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.xl)
                    .frame(maxWidth: 480)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

extension View {
    /// Counts the screen's time and taps toward the item's interaction measurement.
    func measuresInteraction(_ model: ReviewFlowModel) -> some View {
        let meter = model.meter
        let session = model.request.sessionID
        return onAppear { meter.enter(session) }
            .onDisappear { meter.leave(session) }
    }

    /// Shows a failed step's message; the seller stays on the screen and can try again.
    func actionErrorAlert(_ model: ReviewFlowModel) -> some View {
        alert(
            "Couldn't save",
            isPresented: Binding(
                get: { model.actionError != nil },
                set: {
                    if !$0 {
                        model.actionError = nil
                    }
                },
            ),
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionError ?? "")
        }
    }
}
