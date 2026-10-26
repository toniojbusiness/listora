import DesignSystem
import ListoraAPI
import SwiftUI

/// The Tasks tab: the marketplace steps that need the seller, such as finishing a Poshmark
/// listing or delisting after a sale. Urgent ones are pinned at the top. Opening one shows what
/// to copy, the photos to save, the link to the marketplace, and Done.
public struct TasksView: View {
    private let environment: TasksEnvironment
    @State private var path: [UserTask] = []
    @State private var toast: Toast?
    @Environment(\.signIn) private var signIn

    public init(environment: TasksEnvironment) {
        self.environment = environment
    }

    private var inbox: TaskInboxModel {
        environment.inbox
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .background(Palette.background)
                .navigationTitle("Tasks")
                .navigationDestination(for: UserTask.self) { task in
                    TaskDetailView(model: environment.makeDetailModel(task: task)) { outcome in
                        path.removeAll()
                        inbox.remove(taskID: task.id)
                        toast = Toast(outcome == .completed ? "Done (you confirmed)" : "Task dismissed", tone: .success)
                        Task { await inbox.load() }
                    }
                }
                .task { await inbox.load() }
                .refreshable { await inbox.load() }
        }
        .toast($toast)
    }

    private var content: some View {
        phaseContent.motion(value: inbox.phase)
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch inbox.phase {
        case .loading where inbox.tasks.isEmpty:
            SkeletonList(label: "Loading tasks")
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your tasks",
                message: "Marketplace steps that need you show up here once you're signed in.",
                action: .signIn(signIn),
            )
        case let .failed(message) where inbox.tasks.isEmpty:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Tasks didn't load",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await inbox.load() } },
            )
        default:
            if inbox.tasks.isEmpty {
                EmptyStateView(
                    systemImage: "checkmark.circle",
                    tone: .success,
                    title: "You're all caught up",
                    message: "Marketplace steps that need you, like finishing a Poshmark listing, show up here.",
                    action: .init("Check again", systemImage: "arrow.clockwise") { Task { await inbox.load() } },
                )
                .accessibilityIdentifier("tasks.empty")
            } else {
                list
            }
        }
    }

    private var list: some View {
        List {
            if !inbox.urgent.isEmpty {
                Section {
                    ForEach(inbox.urgent, id: \.id, content: row)
                } header: {
                    UrgentHeader(count: inbox.urgent.count)
                }
            }
            if !inbox.others.isEmpty {
                Section {
                    ForEach(inbox.others, id: \.id, content: row)
                } header: {
                    SectionHeader("To do", subtitle: "Finish each one in the marketplace's app, then tap Done.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func row(_ task: UserTask) -> some View {
        NavigationLink(value: task) {
            TaskRow(task: task)
        }
        .listRowBackground(Palette.surface.color)
    }
}

/// Pins the urgent tasks under a clear warning: an item sold, and its other listings are still up.
private struct UrgentHeader: View {
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
            Image(systemName: StatusTone.failed.systemImage)
                .foregroundStyle(Palette.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(count == 1 ? "Urgent" : "Urgent (\(count))")
                    .font(Typography.eyebrow)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Palette.danger)
                    .accessibilityAddTraits(.isHeader)
                Text("An item sold. Do these now so nothing sells twice.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textPrimary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.urgent")
    }
}

/// One task: the item's cover or the task's icon, the server's title, the item, and urgency.
struct TaskRow: View {
    let task: UserTask

    var body: some View {
        let presentation = TaskPresentation(task)
        ListRow(task.title, subtitle: subtitle) {
            TaskThumbnail(task: task, presentation: presentation)
        } trailing: {
            if presentation.isUrgent {
                StatusBadge("Urgent", tone: .failed)
            } else {
                Text(task.createdAt, format: .relative(presentation: .named))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    /// The UI tests' handle: `tasks.row.list_manually.poshmark.AJ-000184`.
    private var identifier: String {
        let kind = task.kind.value1?.rawValue ?? task.kind.value2 ?? "unknown"
        let marketplace = task.marketplace?.value1?.rawValue ?? task.marketplace?.value2 ?? "none"
        return "tasks.row.\(kind).\(marketplace).\(task.item?.sku ?? "none")"
    }

    private var subtitle: String? {
        guard let item = task.item else { return nil }
        guard let title = item.title, !title.isEmpty else { return item.sku }
        return "\(title) · \(item.sku)"
    }
}

/// The item's cover photo, or the task's icon when there is none.
struct TaskThumbnail: View {
    let task: UserTask
    let presentation: TaskPresentation
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 44

    var body: some View {
        if let url = (task.item?.coverPhoto?.urls?.thumbnail).flatMap(URL.init(string:)) {
            RemoteImage(url: url) {
                Palette.surfaceSecondary.color
            }
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: presentation.systemImage)
                    .font(Typography.label)
                    .imageScale(.small)
                    .foregroundStyle(presentation.isUrgent ? Palette.onDanger : Palette.onBrand)
                    .padding(3)
                    .background(presentation.isUrgent ? Palette.danger : Palette.brand, in: Circle())
                    .offset(x: 4, y: 4)
            }
            .accessibilityHidden(true)
        } else {
            IconTile(systemImage: presentation.systemImage, tone: presentation.isUrgent ? .failed : .actionNeeded)
        }
    }
}
