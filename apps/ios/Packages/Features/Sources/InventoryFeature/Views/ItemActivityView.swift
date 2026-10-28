import DesignSystem
import SwiftUI

/// The item's activity: everything that happened to it, newest first, each line with who did it
/// (Listora, you, the marketplace), when, and how it went.
struct ItemActivityView: View {
    @State private var model: ItemActivityModel

    init(model: ItemActivityModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
            .refreshable { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.rows.isEmpty:
            ScrollView {
                VStack(spacing: Spacing.sm) {
                    ForEach(0 ..< 4, id: \.self) { _ in SkeletonRow().cardStyle() }
                }
                .padding(Spacing.md)
            }
            .scrollDisabled(true)
            .accessibilityLabel("Loading activity")
        case let .failed(message) where model.rows.isEmpty:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Activity unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if model.rows.isEmpty {
                EmptyStateView(
                    systemImage: "clock",
                    title: "Nothing yet",
                    message: "What Listora does with this item shows here.",
                )
            } else {
                list
            }
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(model.rows) { row in
                    ActivityRow(row: row)
                        .cardStyle()
                        .onAppear {
                            if row.id == model.rows.last?.id {
                                Task { await model.loadMore() }
                            }
                        }
                }
                if model.isLoadingMore {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(Spacing.sm)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("item.activity.list")
    }
}

/// One line: an icon in the outcome's tone, the words, then who and when.
private struct ActivityRow: View {
    let row: ActivityRowContent

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .top, spacing: Spacing.sm) {
                IconTile(systemImage: row.systemImage, tone: row.tone)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(row.title)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = row.detail {
                        Text(detail)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(meta)
                        .font(Typography.metadata)
                        .foregroundStyle(Palette.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "Listora · Oct 26, 2:41 PM".
    private var meta: String {
        let when = row.date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return "\(row.source) · \(when)"
    }
}
