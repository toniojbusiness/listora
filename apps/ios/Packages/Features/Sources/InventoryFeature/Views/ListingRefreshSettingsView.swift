import DesignSystem
import ListoraAPI
import SwiftUI

/// Settings > Listing refresh: how often Listora refreshes live listings that haven't sold, the
/// quiet hours when it never starts one, and whether Depop listings are relisted, which resets
/// their likes (docs/features/listing-refresh.md).
struct ListingRefreshSettingsView: View {
    @Bindable var model: ListingRefreshSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var isConfirmingRelist = false

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
                    if model.showsDepopRelist {
                        depopRelistCard
                    }
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
                + "followers on Poshmark, and saved unchanged on Mercari. eBay listings aren't "
                + "refreshed. Refreshes stay within each marketplace's pace, and an item can have "
                + "its own setting on its screen.",
        )
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Depop shows only a new listing as new, so its refresh is a relist, which the seller turns
    /// on knowing it resets the listing's likes.
    private var depopRelistCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Toggle("Relist on Depop", isOn: relistBinding)
                .font(Typography.body)
                .tint(Palette.brand.color)
                .accessibilityIdentifier("refreshSettings.depopRelist")
            Text(
                "Depop only shows a listing as new when it's relisted. Listora posts a fresh copy "
                    + "with the same photos, text, and price, checks it's live, then deletes the old "
                    + "one. Relisting resets the listing's likes and saves. Listings with an offer "
                    + "waiting are skipped.",
            )
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .cardStyle(.flat)
        .confirmationDialog(
            "Relist Depop listings to refresh them?",
            isPresented: $isConfirmingRelist,
            titleVisibility: .visible,
        ) {
            Button("Relist on Depop") { model.relistOnDepop = true }
                .accessibilityIdentifier("refreshSettings.depopRelist.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Each relisted listing starts again with no likes or saves.")
        }
    }

    /// Turning relisting on asks first; turning it off doesn't.
    private var relistBinding: Binding<Bool> {
        Binding(
            get: { model.relistOnDepop },
            set: { turnedOn in
                if turnedOn {
                    isConfirmingRelist = true
                } else {
                    model.relistOnDepop = false
                }
            },
        )
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
