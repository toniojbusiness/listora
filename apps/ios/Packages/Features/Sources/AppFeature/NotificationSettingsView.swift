import DesignSystem
import MarketplaceLinkingFeature
import SwiftUI
import TodayFeature
import UIKit
import UserNotifications

/// Settings > Notifications and delisting: the morning summary (TodayFeature), "Ask before
/// delisting" (MarketplaceLinkingFeature), and whether iOS lets Listora notify at all, with the
/// way to iOS Settings when it does not.
struct NotificationSettingsView: View {
    let today: TodayEnvironment
    let saleEmails: SaleEmailsModel
    @State private var permission: UNAuthorizationStatus?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if permission == .denied {
                Section {
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Banner(
                            "Notifications are off",
                            message: "Turn them on in iOS Settings to hear about sales, delists, and tasks.",
                            tone: .actionNeeded,
                            identifier: "notifications.off",
                        )
                        Button("Open iOS Settings", systemImage: "gear") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                openURL(url)
                            }
                        }
                        .buttonStyle(.listora(.secondary, size: .compact))
                        .accessibilityIdentifier("notifications.openSettings")
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                NavigationLink {
                    today.morningSummaryScreen()
                } label: {
                    ListRow(
                        "Morning summary",
                        subtitle: "One notification a day with what needs you.",
                        systemImage: "sun.max",
                    )
                }
                .accessibilityIdentifier("notifications.morningSummary")
            } header: {
                SectionHeader("Notifications")
            }
            .listRowBackground(Palette.surface.color)
            Section {
                AskBeforeDelistToggle(model: saleEmails)
            } header: {
                SectionHeader("After a sale")
            } footer: {
                Text("Otherwise Listora delists a sold item everywhere else at once.")
            }
            .listRowBackground(Palette.surface.color)
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .foregroundStyle(Palette.textPrimary)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scenePhase) {
            permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }
}
