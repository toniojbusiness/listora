import DesignSystem
import SwiftUI

/// The morning summary: one notification a day, at the seller's time, with what needs them.
struct SummarySettingsView: View {
    @Bindable var model: SummarySettingsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .navigationTitle("Morning summary")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task {
                                if await model.save() {
                                    dismiss()
                                }
                            }
                        }
                        .disabled(model.phase != .loaded || model.isSaving)
                        .accessibilityIdentifier("summarySettings.save")
                    }
                }
                .task { await model.load() }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading the morning summary")
        case let .failed(message):
            EmptyStateView(
                systemImage: "bell.slash",
                tone: .failed,
                title: "Setting unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    VStack(spacing: Spacing.sm) {
                        Toggle("Send a morning summary", isOn: $model.isEnabled)
                            .font(Typography.body)
                            .tint(Palette.brand.color)
                            .accessibilityIdentifier("summarySettings.enabled")
                        Divider().overlay(Palette.separator.color)
                        DatePicker("Time", selection: time, displayedComponents: .hourAndMinute)
                            .font(Typography.body)
                            .disabled(!model.isEnabled)
                            .accessibilityIdentifier("summarySettings.time")
                    }
                    .cardStyle(.outlined)
                    Text(
                        "One notification a day with what needs you, like items to ship and delists. "
                            + "Nothing is sent on a day you're all caught up.",
                    )
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    if let error = model.saveError {
                        Banner("Couldn't save", message: error, tone: .failed)
                    }
                }
                .padding(Spacing.md)
            }
        }
    }

    /// The time of day as a date today, for the picker.
    private var time: Binding<Date> {
        Binding(
            get: { Calendar.current.date(from: model.time) ?? Date() },
            set: { date in
                model.time = Calendar.current.dateComponents([.hour, .minute], from: date)
            },
        )
    }
}
