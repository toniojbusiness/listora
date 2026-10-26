import APIClient
import DesignSystem
import SwiftUI

/// The task an item's listing waits on, opened from the item screen's "Open task". It finds the
/// open task of that operation; when there is none any more (done meanwhile, or dismissed), it
/// says so instead of showing a stale one.
struct OperationTaskView: View {
    let environment: TasksEnvironment
    let itemID: String
    let operationID: String
    let onFinished: @MainActor () -> Void

    private enum Phase {
        case loading
        case found(TaskDetailModel)
        case gone
        case failed(String)
    }

    @State private var phase = Phase.loading
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close") { dismiss() }
                            .accessibilityIdentifier("task.close")
                    }
                }
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            SkeletonList(count: 3, label: "Loading task")
        case let .found(model):
            TaskDetailView(model: model) { _ in
                Task { await environment.inbox.load() }
                onFinished()
            }
        case .gone:
            EmptyStateView(
                systemImage: "checkmark.circle",
                tone: .success,
                title: "Nothing to do here",
                message: "This step isn't waiting for you any more. The item shows where it stands.",
                action: .init("Close") { dismiss() },
            )
        case let .failed(message):
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "The task didn't load",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await load() } },
            )
        }
    }

    private func load() async {
        phase = .loading
        do {
            let tasks = try await environment.service.openTasks(itemID: itemID)
            if let task = tasks.first(where: { $0.operationId == operationID }) {
                phase = .found(environment.makeDetailModel(task: task))
            } else {
                phase = .gone
            }
        } catch {
            phase = .failed(error.message)
        }
    }
}
