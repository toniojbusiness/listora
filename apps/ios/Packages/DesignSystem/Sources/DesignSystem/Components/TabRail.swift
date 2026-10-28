import SwiftUI
import UIKit

/// One tab on the ``TabRail``.
public struct TabRailItem<ID: Hashable>: Identifiable {
    public let id: ID
    let title: String
    let systemImage: String
    let badge: Int
    let badgeDescription: String?
    let isTag: Bool

    /// `badge` counts what waits in the tab (0 shows none); `badgeDescription` is how VoiceOver
    /// reads it ("2 need you"), the count alone when nil. `isTag` makes the tab the clay tag that
    /// hangs from the rail: the screen's one main way in (Add).
    public init(
        id: ID,
        title: String,
        systemImage: String,
        badge: Int = 0,
        badgeDescription: String? = nil,
        isTag: Bool = false,
    ) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.badge = badge
        self.badgeDescription = badgeDescription
        self.isTag = isTag
    }
}

/// The app's tab bar: a rail across the bottom of the screen with the tabs under it, and the main
/// tab (Add) a clay price tag hanging from the rail. It is solid, so content scrolling under it
/// never shows through. Each tab is a button with the selected trait on the current one and its
/// badge as the value, and the labels stop growing at the largest text sizes like the system's,
/// with the large content viewer on a long press. It does not carry SwiftUI's tab bar trait: with
/// it, UI tests see every icon and title inside as another button of the same name.
///
/// A `TabView` keeps owning the tabs' state; ``SwiftUI/View/tabRail(_:selection:)`` hides the
/// system bar and puts this one in its place.
public struct TabRail<ID: Hashable>: View {
    private let items: [TabRailItem<ID>]
    @Binding private var selection: ID

    /// How far the tag rises above the rail, and its string above the tag.
    private static var tagRise: CGFloat {
        26
    }

    /// A tab's height, the system tab bar's.
    private static var tabHeight: CGFloat {
        49
    }

    private static var stringRise: CGFloat {
        10
    }

    public init(_ items: [TabRailItem<ID>], selection: Binding<ID>) {
        self.items = items
        _selection = selection
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            ForEach(items) { item in
                Button {
                    selection = item.id
                } label: {
                    if item.isTag {
                        tag(item)
                    } else {
                        tab(item)
                    }
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(item.title)
                .accessibilityValue(badgeValue(item))
                .accessibilityAddTraits(selection == item.id ? .isSelected : [])
                .accessibilityShowsLargeContentViewer {
                    Label(item.title, systemImage: item.systemImage)
                }
                .sensoryFeedback(.selection, trigger: selection == item.id) { _, selected in selected }
            }
        }
        .padding(.horizontal, Spacing.xs)
        .padding(.top, Spacing.xxs)
        .background(alignment: .top) {
            ZStack(alignment: .top) {
                Rectangle()
                    .fill(Palette.background)
                    .ignoresSafeArea(edges: .bottom)
                Capsule()
                    .fill(Palette.rail)
                    .frame(height: 2.5)
                    .padding(.horizontal, Spacing.xs)
            }
            .accessibilityHidden(true)
        }
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tabRail")
    }

    private func badgeValue(_ item: TabRailItem<ID>) -> Text {
        guard item.badge > 0 else { return Text("") }
        return Text(item.badgeDescription ?? "\(item.badge)")
    }

    private func tab(_ item: TabRailItem<ID>) -> some View {
        let isSelected = selection == item.id
        return VStack(spacing: 3) {
            Image(systemName: item.systemImage)
                .font(.system(size: 20, weight: isSelected ? .semibold : .regular))
                .symbolVariant(isSelected ? .fill : .none)
                .frame(height: 26)
                .overlay(alignment: .topTrailing) {
                    if item.badge > 0 {
                        Text(item.badge > 99 ? "99+" : "\(item.badge)")
                            .font(Typography.label.monospacedDigit())
                            .foregroundStyle(Palette.onDanger)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Palette.danger, in: Capsule())
                            .offset(x: 12, y: -6)
                    }
                }
            Text(item.title)
                .font(Font.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(isSelected ? Palette.brand : Palette.textSecondary)
        .frame(maxWidth: .infinity, minHeight: Self.tabHeight)
        .contentShape(Rectangle())
    }

    /// The clay tag: pointed end up, its eyelet on the rail's string, the stitched edge, the icon,
    /// and the title.
    private func tag(_ item: TabRailItem<ID>) -> some View {
        let shape = TagShape(end: .top, chamfer: 12, cornerRadius: Radius.small)
        return VStack(spacing: 2) {
            Image(systemName: item.systemImage)
                .font(.system(size: 19, weight: .semibold))
            Text(item.title)
                .font(Font.caption2.weight(.bold))
                .lineLimit(1)
        }
        .foregroundStyle(Palette.onBrand)
        .padding(.bottom, Spacing.xs)
        // As tall as a tab plus the part above the rail, which holds the eyelet.
        .frame(width: 64, height: Self.tabHeight + Self.tagRise, alignment: .bottom)
        .background(Palette.brand, in: shape)
        .stitchedEdge(
            TagShape(end: .top, chamfer: 12, cornerRadius: Radius.small, punchesEyelet: false),
            color: Palette.onBrand.color.opacity(0.4),
            inset: 4,
        )
        .overlay(alignment: .top) {
            let eyelet = TagMetrics.eyeletInset + 2
            ZStack(alignment: .top) {
                // The string the tag hangs by, tied into the eyelet from above. The eyelet sits above
                // the rail, so the hole shows the screen, not the rail through it.
                ThreadSegment()
                    .stroke(Palette.rail, style: Thread.stroke(.taut))
                    .frame(width: Thread.width, height: Self.stringRise + eyelet - TagMetrics.eyeletHoleRadius)
                    .offset(y: -Self.stringRise)
                EyeletRing()
                    .offset(y: eyelet - TagMetrics.eyeletRingRadius)
            }
        }
        .elevation(.low)
        .padding(.top, -Self.tagRise)
        .contentShape(shape)
    }
}

/// Which screens of a tab want the rail out of the way (a flow with its own bottom bar, select
/// mode). One per tab: a screen that hides it hides it only in its own tab.
@MainActor
@Observable
final class TabRailVisibility {
    private var hiders: Set<UUID> = []

    var isHidden: Bool {
        !hiders.isEmpty
    }

    func set(_ id: UUID, hidden: Bool) {
        if hidden {
            hiders.insert(id)
        } else {
            hiders.remove(id)
        }
    }
}

private struct TabRailHiddenModifier: ViewModifier {
    let hidden: Bool
    @Environment(TabRailVisibility.self) private var visibility: TabRailVisibility?
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onAppear { visibility?.set(id, hidden: hidden) }
            .onChange(of: hidden) { _, hidden in visibility?.set(id, hidden: hidden) }
            .onDisappear { visibility?.set(id, hidden: false) }
    }
}

private struct TabRailHost<ID: Hashable>: ViewModifier {
    let items: [TabRailItem<ID>]
    @Binding var selection: ID
    @State private var visibility = TabRailVisibility()
    @State private var isKeyboardShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .toolbar(.hidden, for: .tabBar)
            .environment(visibility)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // The rail steps aside for the keyboard, as the system's tab bar stays under it.
                if !visibility.isHidden, !isKeyboardShown {
                    TabRail(items, selection: $selection)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: visibility.isHidden)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                isKeyboardShown = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                isKeyboardShown = false
            }
    }
}

extension View {
    /// Shows `items` on a ``TabRail`` under this tab's screen, in place of the system tab bar.
    /// Apply it to each tab's content inside a `TabView`, which keeps owning `selection`.
    public func tabRail<ID: Hashable>(_ items: [TabRailItem<ID>], selection: Binding<ID>) -> some View {
        modifier(TabRailHost(items: items, selection: selection))
    }

    /// Hides the tab rail while this screen shows and `hidden` is true: a flow with its own bottom
    /// bar, or select mode. The rail comes back when the screen goes away.
    public func tabRailHidden(_ hidden: Bool = true) -> some View {
        modifier(TabRailHiddenModifier(hidden: hidden))
    }
}

#Preview {
    @Previewable @State var selection = 0
    VStack {
        Spacer()
        TabRail([
            TabRailItem(id: 0, title: "Today", systemImage: "sun.max"),
            TabRailItem(id: 1, title: "Inventory", systemImage: "hanger", badge: 2),
            TabRailItem(id: 2, title: "Add", systemImage: "camera", isTag: true),
            TabRailItem(id: 3, title: "Tasks", systemImage: "checklist"),
            TabRailItem(id: 4, title: "Sales", systemImage: "dollarsign.circle"),
        ], selection: $selection)
    }
    .background(Palette.background)
}
