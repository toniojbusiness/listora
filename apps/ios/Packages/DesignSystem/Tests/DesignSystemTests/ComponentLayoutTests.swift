import SwiftUI
import Testing
import UIKit
@testable import DesignSystem

/// Lays the components out the way UIKit would on an iPhone, at the default text size and the
/// largest accessibility size, in light and dark mode, and checks what the eye and finger need:
/// every control is at least the minimum tap target, and text wraps instead of overflowing.
@MainActor
struct ComponentLayoutTests {
    private static let width: CGFloat = 390
    private static let sizes: [DynamicTypeSize] = [.large, .accessibility5]
    private static let schemes: [ColorScheme] = [.light, .dark]

    private func size(of view: some View, typeSize: DynamicTypeSize, scheme: ColorScheme = .light) -> CGSize {
        let host = UIHostingController(rootView: view
            .environment(\.dynamicTypeSize, typeSize)
            .environment(\.colorScheme, scheme))
        return host.sizeThatFits(in: CGSize(width: Self.width, height: .greatestFiniteMagnitude))
    }

    private func everyVariant(_ check: (DynamicTypeSize, ColorScheme) -> Void) {
        for typeSize in Self.sizes {
            for scheme in Self.schemes {
                check(typeSize, scheme)
            }
        }
    }

    @Test(arguments: [
        ListoraButtonStyle.Kind.primary, .secondary, .destructive, .tertiary, .destructiveText,
    ])
    func `buttons meet the tap target and stay inside the screen`(kind: ListoraButtonStyle.Kind) {
        everyVariant { typeSize, scheme in
            for size in [ListoraButtonStyle.Size.large, .compact] {
                let button = Button("Connect your eBay account", systemImage: "link") {}
                    .buttonStyle(.listora(kind, size: size))
                let measured = self.size(of: button, typeSize: typeSize, scheme: scheme)
                #expect(measured.height >= Layout.minimumTapTarget, "\(kind) \(size) at \(typeSize): \(measured)")
                #expect(measured.width <= Self.width, "\(kind) \(size) at \(typeSize) overflows: \(measured)")
            }
        }
    }

    @Test
    func `a loading button keeps its size`() {
        let idle = size(of: Button("Send code") {}.buttonStyle(.listoraPrimary), typeSize: .large)
        let loading = size(of: Button("Send code") {}.buttonStyle(.listoraPrimary).loading(true), typeSize: .large)
        #expect(idle == loading)
    }

    @Test
    func `choice chips meet the tap target`() {
        everyVariant { typeSize, scheme in
            for selected in [true, false] {
                let chip = ChoiceChip("Tag", systemImage: "tag", isSelected: selected) {}
                let measured = size(of: chip, typeSize: typeSize, scheme: scheme)
                #expect(measured.height >= Layout.minimumTapTarget, "chip at \(typeSize): \(measured)")
            }
        }
    }

    @Test
    func `list rows meet the tap target and wrap long text`() {
        everyVariant { typeSize, scheme in
            let row = ListRow(
                "Marketplaces",
                subtitle: "Connect eBay, and see how Listora works with each marketplace.",
                systemImage: "link",
            ) {
                StatusBadge("Reconnect needed", tone: .actionNeeded)
            }
            let measured = size(of: row, typeSize: typeSize, scheme: scheme)
            #expect(measured.height >= Layout.minimumTapTarget)
            #expect(measured.width <= Self.width)
        }
    }

    @Test
    func `text grows with Dynamic Type`() {
        let badge = StatusBadge("Upload failed", tone: .failed)
        #expect(size(of: badge, typeSize: .accessibility5).height > size(of: badge, typeSize: .large).height)
        let banner = Banner("2 photos failed to upload", message: "The server is busy.", tone: .failed)
        #expect(size(of: banner, typeSize: .accessibility5).height > size(of: banner, typeSize: .large).height)
    }

    @Test
    func `banners, fields, and the price field fit the screen at every size`() {
        everyVariant { typeSize, scheme in
            let views: [(String, AnyView)] = [
                ("banner", AnyView(Banner(
                    "Couldn't save the draft to Listora",
                    message: "The server is busy. Listora tries again on its own.",
                    tone: .failed,
                    action: .init("Retry") {},
                    onDismiss: {},
                ))),
                ("text field", AnyView(ListoraTextField(
                    "Email",
                    text: .constant(""),
                    prompt: "you@example.com",
                    error: "Enter an email address.",
                ))),
                ("price field", AnyView(PriceField("Price", minorUnits: .constant(4800)))),
                ("empty state", AnyView(EmptyStateView(
                    systemImage: "shippingbox",
                    title: "No items yet",
                    message: "Create an item once.",
                    steps: ["Take photos", "Check the details", "List it"],
                    action: .init("Add item") {},
                ).frame(height: 900))),
                ("bottom bar", AnyView(BottomActionBar {
                    Button("Take photos") {}.buttonStyle(.listoraPrimary)
                })),
            ]
            let header = size(of: SectionHeader("Drafts", subtitle: "Saved on this iPhone."), typeSize: typeSize)
            #expect(header.width <= Self.width, "section header at \(typeSize) overflows: \(header)")
            for (name, view) in views {
                let measured = size(of: view, typeSize: typeSize, scheme: scheme)
                #expect(measured.width <= Self.width, "\(name) at \(typeSize) overflows: \(measured)")
                #expect(measured.height >= Layout.minimumTapTarget, "\(name) at \(typeSize): \(measured)")
            }
        }
    }
}
