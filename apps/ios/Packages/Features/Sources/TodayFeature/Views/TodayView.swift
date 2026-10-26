import DesignSystem
import SwiftUI

/// The app's home: what needs the seller today, most urgent first, each card with one action
/// that opens the right screen, and how this week's sales compare with last week's. It reads the
/// server each time it appears (back from a card's screen, a tab switch, the app coming to the
/// front) and on pull to refresh, so finished work drops off.
public struct TodayView<Settings: View>: View {
    private let environment: TodayEnvironment
    private let onOpenDrafts: @MainActor () -> Void
    private let onAddItem: (@MainActor () -> Void)?
    private let settings: Settings
    @State private var model: TodayModel
    @State private var path: [TodayDestination] = []
    @State private var summarySettings: SummarySettingsModel?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.signIn) private var signIn

    /// `onOpenDrafts` shows the drafts, which live in another tab, as `onAddItem` opens Add (the
    /// caught-up screen's action); `settings` is the header's button that opens Settings.
    public init(
        environment: TodayEnvironment,
        onOpenDrafts: @escaping @MainActor () -> Void,
        onAddItem: (@MainActor () -> Void)? = nil,
        @ViewBuilder settings: () -> Settings,
    ) {
        self.environment = environment
        self.onOpenDrafts = onOpenDrafts
        self.onAddItem = onAddItem
        self.settings = settings()
        _model = State(initialValue: environment.makeModel())
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .background(Palette.background)
                .navigationTitle("Today")
                .toolbar {
                    if model.phase != .signedOut {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                summarySettings = environment.makeSettingsModel()
                            } label: {
                                Label("Morning summary", systemImage: "bell")
                            }
                            .accessibilityIdentifier("today.summarySettings")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) { settings }
                }
                .navigationDestination(for: TodayDestination.self) { destination in
                    switch destination {
                    case let .item(id): environment.itemDestination(id)
                    case let .sale(id): environment.saleDestination(id)
                    case .marketplaces: environment.marketplacesDestination()
                    // Opened in its own tab, never pushed here.
                    case .drafts: EmptyView()
                    }
                }
                // Runs each time the screen appears, including back from a card's screen.
                .task { await model.load() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task { await model.load() }
                    }
                }
                .sheet(item: $summarySettings) { model in
                    SummarySettingsView(model: model)
                }
        }
    }

    private var content: some View {
        phaseContent.motion(value: model.phase)
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch model.phase {
        case .loading:
            loading
        case .signedOut:
            EmptyStateView(
                systemImage: "sun.max",
                title: "Sign in to see your day",
                message: "Today shows what needs you, like what to ship and what to delist, "
                    + "and how this week's sales are going.",
                action: .signIn(signIn),
            )
            .accessibilityIdentifier("today.signedOut")
        case let .failed(message):
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Today is unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            if model.isCaughtUp, model.money?.hasSales != true {
                EmptyStateView(
                    systemImage: "checkmark.circle",
                    tone: .success,
                    title: "You're all caught up",
                    message: "Nothing needs you right now. Items to ship, delists, and listings "
                        + "that could use a nudge show up here.",
                    action: onAddItem.map { .init("Add an item", systemImage: "camera.fill", handler: $0) },
                )
                .refreshable { await model.load() }
                .accessibilityIdentifier("today.caughtUp")
            } else {
                summary
            }
        }
    }

    /// Shaped like the cards: a photo, two lines, and the action button.
    private var loading: some View {
        SkeletonList(count: 3, label: "Loading today") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SkeletonRow()
                SkeletonBlock(height: Layout.buttonHeight, cornerRadius: Radius.medium)
            }
            .cardStyle()
        }
    }

    private var summary: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.lg) {
                if model.cards.isEmpty {
                    CaughtUpCard()
                } else {
                    Text(model.cards.count == 1 ? "1 thing needs you" : "\(model.cards.count) things need you")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("today.count")
                    ForEach(model.cards) { card in
                        TodayCardView(card: card, onAction: open)
                            .transition(.opacity.combined(with: .move(edge: .leading)))
                    }
                }
                if let money = model.money, money.hasSales {
                    MoneySummaryView(money: money)
                        .padding(.top, Spacing.xs)
                }
            }
            .motion(value: model.cards.map(\.id))
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.load() }
    }

    private func open(_ destination: TodayDestination) {
        switch destination {
        case .drafts: onOpenDrafts()
        case .item, .sale, .marketplaces: path.append(destination)
        }
    }
}

/// Shown above the money summary when nothing needs the seller.
private struct CaughtUpCard: View {
    var body: some View {
        HStack(spacing: Spacing.sm) {
            IconTile(systemImage: "checkmark.circle", tone: .success, size: .card)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("You're all caught up")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text("Nothing needs you right now.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .cardStyle(.tinted(.success))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("today.caughtUp")
    }
}

extension SummarySettingsModel: Identifiable {
    nonisolated var id: ObjectIdentifier {
        ObjectIdentifier(self)
    }
}

extension TodayView where Settings == EmptyView {
    /// Today without a Settings button.
    public init(environment: TodayEnvironment, onOpenDrafts: @escaping @MainActor () -> Void) {
        self.init(environment: environment, onOpenDrafts: onOpenDrafts) { EmptyView() }
    }
}

#Preview {
    TodayView(environment: .preview) {}
}
