import DesignSystem
import SwiftUI

/// Settings > Help and contact: short answers to what sellers ask most, and how to reach Listora.
struct HelpView: View {
    let supportEmail: String?
    let version: String
    @Environment(\.openURL) private var openURL

    /// The questions, in the order a new seller meets them.
    static let topics: [(question: String, answer: String)] = [
        (
            "How do I list an item?",
            "Tap Add, take the guided photos, and check what Listora read. Then choose the marketplaces "
                + "and list it everywhere at once.",
        ),
        (
            "What happens when something sells?",
            "Listora records the sale and takes the item down on your other marketplaces. Today shows "
                + "what to ship and any delist that still needs you.",
        ),
        (
            "A marketplace says to sign in again",
            "Open Linked marketplaces and tap Relink next to it. You sign in on the marketplace's own "
                + "page; Listora never sees your password.",
        ),
        (
            "A change didn't go through",
            "Listora shows a change as done only once the marketplace confirms it. Anything that failed "
                + "says why and has Retry.",
        ),
    ]

    var body: some View {
        List {
            Section {
                ForEach(Self.topics, id: \.question) { topic in
                    DisclosureGroup {
                        Text(topic.answer)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.vertical, Spacing.xxs)
                    } label: {
                        Text(topic.question)
                            .font(Typography.body)
                            .foregroundStyle(Palette.textPrimary)
                    }
                    .tint(Palette.brand.color)
                }
            } header: {
                SectionHeader("Common questions")
            }
            .listRowBackground(Palette.surface.color)
            Section {
                if let supportEmail, let url = mailURL(to: supportEmail) {
                    Button {
                        openURL(url)
                    } label: {
                        ListRow("Email Listora support", subtitle: supportEmail, systemImage: "envelope")
                    }
                    .accessibilityIdentifier("help.email")
                } else {
                    ListRow(
                        "Contact isn't set up yet",
                        subtitle: "This Listora doesn't have a support address yet.",
                        systemImage: "envelope",
                        tone: .neutral,
                    )
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("help.noContact")
                }
            } header: {
                SectionHeader("Contact")
            }
            .listRowBackground(Palette.surface.color)
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .foregroundStyle(Palette.textPrimary)
        .navigationTitle("Help and contact")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// A new email with the version in its subject, so support knows which app wrote.
    private func mailURL(to address: String) -> URL? {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = address
        components.queryItems = [URLQueryItem(name: "subject", value: "Listora help (version \(version))")]
        return components.url
    }
}
