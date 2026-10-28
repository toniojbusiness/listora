import DesignSystem
import ListoraAPI
import SwiftUI

/// Settings > Listing refresh: how often Listora refreshes live listings that haven't sold, and
/// the quiet hours when it never starts one (docs/features/listing-refresh.md).
struct ListingRefreshSettingsView: View {
    @Bindable var model: ListingRefreshSettingsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Listing refresh")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.save() {
                                dismiss()
                            }
                        }
                    }
                    .disabled(model.phase != .loaded || model.isSaving || model.quietHoursAreEmpty)
                    .accessibilityIdentifier("refreshSettings.save")
                }
            }
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 2, label: "Loading listing refresh")
        case let .failed(message):
            EmptyStateView(
                systemImage: "arrow.clockwise.circle",
                tone: .failed,
                title: "Setting unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    cadenceCard
                    explanation
                    quietHoursCard
                    if let error = model.saveError {
                        Banner("Couldn't save", message: error, tone: .failed)
                    }
                }
                .padding(Spacing.md)
            }
        }
    }

    private var cadenceCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Picker("Refresh listings", selection: $model.cadence) {
                ForEach(RefreshWords.cadences, id: \.self) { cadence in
                    Text(RefreshWords.name(cadence)).tag(cadence)
                }
            }
            .pickerStyle(.navigationLink)
            .font(Typography.body)
            .accessibilityIdentifier("refreshSettings.cadence")
            if model.cadence == .custom {
                Divider().overlay(Palette.separator.color)
                Stepper(value: $model.customHours, in: ListingRefreshSettingsModel.customHoursRange, step: 12) {
                    Text(RefreshWords.hours(model.customHours))
                        .font(Typography.body)
                }
                .accessibilityIdentifier("refreshSettings.customHours")
            }
        }
        .cardStyle(.flat)
    }

    private var explanation: some View {
        Text(
            "A listing that hasn't sold is refreshed so it shows as new again: shared to your "
                + "followers on Poshmark, and saved unchanged on Mercari and Depop. Listora never "
                + "deletes and reposts, so likes and watchers stay. eBay listings aren't refreshed. "
                + "Refreshes stay within each marketplace's pace, and an item can have its own "
                + "setting on its screen.",
        )
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var quietHoursCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Toggle("Quiet hours", isOn: $model.hasQuietHours)
                .font(Typography.body)
                .tint(Palette.brand.color)
                .accessibilityIdentifier("refreshSettings.quietHours")
            if model.hasQuietHours {
                Divider().overlay(Palette.separator.color)
                DatePicker("From", selection: time(\.quietStart), displayedComponents: .hourAndMinute)
                    .font(Typography.body)
                    .accessibilityIdentifier("refreshSettings.quietStart")
                DatePicker("To", selection: time(\.quietEnd), displayedComponents: .hourAndMinute)
                    .font(Typography.body)
                    .accessibilityIdentifier("refreshSettings.quietEnd")
                Text(
                    model.quietHoursAreEmpty
                        ? "Pick an end time that differs from the start."
                        : "No refresh starts in these hours.",
                )
                .font(Typography.footnote)
                .foregroundStyle(model.quietHoursAreEmpty ? Palette.warning : Palette.textSecondary)
            }
        }
        .cardStyle(.flat)
    }

    /// A time of day as a date today, for the pickers.
    private func time(_ keyPath: ReferenceWritableKeyPath<ListingRefreshSettingsModel, DateComponents>)
        -> Binding<Date>
    {
        Binding(
            get: { Calendar.current.date(from: model[keyPath: keyPath]) ?? Date() },
            set: { date in
                model[keyPath: keyPath] = Calendar.current.dateComponents([.hour, .minute], from: date)
            },
        )
    }
}
