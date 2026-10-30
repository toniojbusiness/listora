import DesignSystem
import SwiftUI

/// Settings > Pack check: the switch, and "How Pack check works" in plain words. Off by default.
struct PackCheckSettingsView: View {
    let environment: PackCheckEnvironment
    private var model: PackCheckSettingsModel {
        environment.settings
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Pack check")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 2, label: "Loading Pack check")
        case let .failed(message):
            EmptyStateView(
                systemImage: "shippingbox",
                tone: .failed,
                title: "Setting unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Toggle("Check each package before it ships", isOn: enabled)
                        .font(Typography.body)
                        .tint(Palette.brand.color)
                        .disabled(model.isSaving)
                        .cardStyle(.flat)
                        .accessibilityIdentifier("packCheck.enabled")
                    if let error = model.saveError {
                        Banner("Couldn't save", message: error, tone: .failed)
                    }
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        SectionHeader("How Pack check works")
                        PackCheckExplainer()
                    }
                    .cardStyle(.flat)
                    if model.isEnabled {
                        NavigationLink {
                            environment.ordersScreen()
                        } label: {
                            Label("Open the to-ship list", systemImage: "shippingbox")
                        }
                        .buttonStyle(ListoraButtonStyle(.primary))
                        .accessibilityIdentifier("packCheck.openList")
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { model.isEnabled },
            set: { value in Task { await model.setEnabled(value) } },
        )
    }
}
