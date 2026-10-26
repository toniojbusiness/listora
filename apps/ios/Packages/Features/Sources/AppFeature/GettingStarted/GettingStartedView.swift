import DesignSystem
import SwiftUI

/// The first-run guide after signing in: three short steps (link your marketplaces, add your
/// first item, see it listed), one per page, with Skip always at hand. The last page's button
/// opens Add; the first page's "Link accounts now" opens Settings > Link accounts. Either way, or
/// skipped, the guide is done for good (``GettingStartedModel``).
struct GettingStartedView: View {
    let onLinkAccounts: @MainActor () -> Void
    let onAddItem: @MainActor () -> Void
    let onSkip: @MainActor () -> Void

    @State private var page = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct Step: Equatable {
        let systemImage: String
        let title: String
        let message: String
    }

    static let steps = [
        Step(
            systemImage: "link",
            title: "Link your marketplaces",
            message: "Sign in to eBay, Depop, Poshmark, and Mercari once, in Settings, so Listora can list "
                + "and delist there for you.",
        ),
        Step(
            systemImage: "camera.fill",
            title: "Add your first item",
            message: "Take photos of the front, the back, and the tag. Listora suggests the details and a "
                + "price for you to check.",
        ),
        Step(
            systemImage: "shippingbox",
            title: "See it listed",
            message: "Choose where to list it. Inventory shows its status on each marketplace, as that "
                + "marketplace confirms it.",
        ),
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("Skip", action: onSkip)
                    .buttonStyle(.listora(.tertiary, size: .compact))
                    .accessibilityIdentifier("gettingStarted.skip")
            }
            .padding(.horizontal, Spacing.xs)
            TabView(selection: $page) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
                    StepPage(step: step, number: index + 1, count: Self.steps.count)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: page)
            PageDots(count: Self.steps.count, current: page)
                .padding(.bottom, Spacing.md)
            actions
                .padding(.horizontal, Spacing.md)
                .padding(.bottom, Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
        }
        .background(Palette.background)
        .sensoryFeedback(.selection, trigger: page)
    }

    private var actions: some View {
        VStack(spacing: Spacing.xs) {
            if page < Self.steps.count - 1 {
                Button("Continue") { page += 1 }
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("gettingStarted.continue")
            } else {
                Button(action: onAddItem) {
                    Label("Add your first item", systemImage: "camera.fill")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("gettingStarted.addItem")
            }
            // Same height on every page, so the primary button never jumps.
            Button("Link accounts now", action: onLinkAccounts)
                .buttonStyle(.listora(.tertiary, size: .large))
                .opacity(page == 0 ? 1 : 0)
                .disabled(page != 0)
                .accessibilityHidden(page != 0)
                .accessibilityIdentifier("gettingStarted.linkAccounts")
        }
    }
}

/// One step: the illustration, "Step 1 of 3", its title, and a sentence. Scrolls when the text is
/// large.
private struct StepPage: View {
    let step: GettingStartedView.Step
    let number: Int
    let count: Int

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: Spacing.lg) {
                    SpotIllustration(systemImage: step.systemImage)
                    VStack(spacing: Spacing.xs) {
                        Text("Step \(number) of \(count)")
                            .font(Typography.eyebrow)
                            .textCase(.uppercase)
                            .tracking(0.6)
                            .foregroundStyle(Palette.brand)
                        Text(step.title)
                            .font(Typography.largeTitle)
                            .foregroundStyle(Palette.textPrimary)
                            .accessibilityAddTraits(.isHeader)
                        Text(step.message)
                            .font(Typography.body)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .multilineTextAlignment(.center)
                }
                .padding(.horizontal, Spacing.xl)
                .padding(.vertical, Spacing.lg)
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gettingStarted.step.\(number)")
    }
}

/// Which page is showing, as dots; VoiceOver reads "Step 2 of 3". Its accessibility frame is a
/// full tap target (the audit checks every element's), drawn over the space around the dots so
/// the layout stays 8 points tall.
private struct PageDots: View {
    let count: Int
    let current: Int

    private static let dotHeight: CGFloat = 8

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(0 ..< count, id: \.self) { index in
                Capsule()
                    .fill(index == current ? Palette.brand.color : Palette.separator.color)
                    .frame(width: index == current ? 22 : 8, height: Self.dotHeight)
            }
        }
        .motion(Motion.snappy, value: current)
        .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(current + 1) of \(count)")
        .accessibilityIdentifier("gettingStarted.pageDots")
        .padding(.vertical, -(Layout.minimumTapTarget - Self.dotHeight) / 2)
    }
}

#Preview {
    GettingStartedView(onLinkAccounts: {}, onAddItem: {}, onSkip: {})
}
