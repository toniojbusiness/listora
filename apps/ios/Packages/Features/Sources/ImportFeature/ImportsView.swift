import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// Import listings (docs/features/imports.md): bring the listings a seller already has for sale on
/// Depop, Poshmark, and Mercari into Listora as items, each already listed there. Listora only
/// reads the marketplace, in the seller's linked session (on this iPhone for the marketplaces
/// that run here), and changes nothing on it. Each marketplace shows the server's progress and
/// summary, and the questions it has for the seller.
public struct ImportsView: View {
    @State private var model: ImportsModel
    private let questions: (String) -> ImportQuestionsModel

    /// `questions` makes the model of an import's questions screen.
    public init(model: ImportsModel, questions: @escaping (String) -> ImportQuestionsModel) {
        _model = State(initialValue: model)
        self.questions = questions
    }

    private static let intro = """
    Bring the listings you already have into Listora. Each one becomes an item that's already \
    listed there, so you can list it on the others in one tap. Listora only reads your listings \
    and changes nothing on the marketplace.
    """

    public var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Import listings")
            .task { await model.watch() }
            .onReceive(NotificationCenter.default.publisher(for: .phoneWorkFinished)) { _ in
                Task { await model.load() }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.rows.isEmpty:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading marketplaces")
        case let .failed(message) where model.rows.isEmpty:
            EmptyStateView(
                systemImage: "square.and.arrow.down",
                tone: .failed,
                title: "Imports unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            list
        }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let notice = model.notice {
                    Banner(
                        notice.message,
                        tone: notice.tone,
                        onDismiss: { model.dismissNotice() },
                        identifier: "imports.notice",
                    )
                    .transition(.rise)
                }
                Text(Self.intro)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(model.rows) { row in
                    ImportRowView(
                        row: row,
                        questions: questions,
                        isStarting: model.starting == row.id,
                        isEnabled: model.starting == nil,
                        start: { Task { await model.start(row) } },
                    )
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.rows)
            .motion(value: model.notice)
        }
        .refreshable { await model.load() }
    }
}

/// One marketplace: its newest import's progress or summary, its questions, and Import.
struct ImportRowView: View {
    let row: ImportRow
    /// Pushed with its own destination, since Settings' navigation path holds only its own screens.
    let questions: (String) -> ImportQuestionsModel
    let isStarting: Bool
    let isEnabled: Bool
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.name)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Spacer()
                if let latest = row.latest {
                    StatusBadge(
                        latest.isRunning ? "Importing" : latest.needsYou > 0 ? "Needs you" : "Done",
                        tone: latest.tone,
                    )
                    .accessibilityIdentifier("imports.\(row.id).badge")
                }
            }
            if let latest = row.latest {
                Text(latest.summary ?? latest.progress)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("imports.\(row.id).summary")
                if latest.isRunning, latest.summary != nil {
                    Text(latest.progress)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("imports.\(row.id).progress")
                }
                if latest.isRunning {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .tint(Palette.brand.color)
                        .accessibilityLabel(latest.progress)
                }
                if let stopped = latest.stoppedReason {
                    Text(stopped)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("imports.\(row.id).stopped")
                }
                if latest.needsYou > 0 {
                    NavigationLink {
                        ImportQuestionsView(model: questions(latest.importID), marketplace: row.name)
                    } label: {
                        Label(
                            latest.needsYou == 1 ? "Answer 1 question" : "Answer \(latest.needsYou) questions",
                            systemImage: "questionmark.circle",
                        )
                    }
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .accessibilityIdentifier("imports.\(row.id).questions")
                }
            } else if let reason = row.unavailableReason {
                Text(reason)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Nothing imported yet.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            if row.canStart {
                Button(row.startTitle, systemImage: "square.and.arrow.down", action: start)
                    .buttonStyle(row.latest == nil ? .listoraPrimary : .listora(.secondary, size: .compact))
                    .loading(isStarting)
                    .disabled(!isEnabled)
                    .accessibilityIdentifier("imports.\(row.id).start")
            } else if row.latest != nil, let reason = row.unavailableReason, row.latest?.isRunning != true {
                Text(reason)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("imports.\(row.id)")
    }
}
