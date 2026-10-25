import Testing
@testable import DesignSystem

/// Every theme's colors meet the same rules, so the Dev palette switch can never ship a pair
/// that fails WCAG AA.
struct PaletteTests {
    /// WCAG AA minimum for normal-size text.
    private static let minimumTextContrast = 4.5

    private static func backgrounds(_ theme: PaletteTheme) -> [(String, ColorToken)] {
        [
            ("background", theme.background),
            ("surface", theme.surface),
            ("surfaceSecondary", theme.surfaceSecondary),
        ]
    }

    private static func foregrounds(_ theme: PaletteTheme) -> [(String, ColorToken)] {
        [
            ("textPrimary", theme.textPrimary),
            ("textSecondary", theme.textSecondary),
            ("brand", theme.brand),
            ("success", theme.success),
            ("warning", theme.warning),
            ("danger", theme.danger),
            ("info", theme.info),
        ]
    }

    /// A tone's strong color and the soft background it sits on.
    private struct SoftPair {
        let name: String
        let strong: ColorToken
        let soft: ColorToken
    }

    private static func softPairs(_ theme: PaletteTheme) -> [SoftPair] {
        [
            SoftPair(name: "brand", strong: theme.brand, soft: theme.brandSoft),
            SoftPair(name: "success", strong: theme.success, soft: theme.successSoft),
            SoftPair(name: "warning", strong: theme.warning, soft: theme.warningSoft),
            SoftPair(name: "danger", strong: theme.danger, soft: theme.dangerSoft),
            SoftPair(name: "info", strong: theme.info, soft: theme.infoSoft),
        ]
    }

    private func expectReadable(
        _ text: ColorToken,
        on background: ColorToken,
        _ description: String,
        theme: PaletteTheme,
    ) {
        let light = text.light.contrastRatio(with: background.light)
        let dark = text.dark.contrastRatio(with: background.dark)
        #expect(light >= Self.minimumTextContrast, "\(theme.name): \(description) (light) is \(light):1")
        #expect(dark >= Self.minimumTextContrast, "\(theme.name): \(description) (dark) is \(dark):1")
    }

    @Test
    func `controls on photos are readable on the media background`() {
        #expect(Palette.onMedia.light.contrastRatio(with: Palette.mediaBackground.light) >= Self.minimumTextContrast)
        #expect(Palette.onMedia.dark.contrastRatio(with: Palette.mediaBackground.dark) >= Self.minimumTextContrast)
    }

    @Test
    func `RGB parses 0xRRGGBB channels`() {
        let rgb = RGB(hex: 0xFF8000)
        #expect(rgb.red == 1)
        #expect(abs(rgb.green - 128.0 / 255) < 1e-9)
        #expect(rgb.blue == 0)
    }

    @Test
    func `contrast ratio matches the WCAG reference values`() {
        let black = RGB(hex: 0x000000)
        let white = RGB(hex: 0xFFFFFF)
        #expect(abs(black.contrastRatio(with: white) - 21) < 1e-9)
        #expect(white.contrastRatio(with: black) == black.contrastRatio(with: white))
        #expect(white.contrastRatio(with: white) == 1)
        // #767676 on white is the well-known 4.54:1 AA threshold gray.
        #expect(abs(RGB(hex: 0x767676).contrastRatio(with: white) - 4.54) < 0.01)
    }

    @Test(arguments: PaletteTheme.all)
    func `every foreground is readable on every background in light and dark mode`(theme: PaletteTheme) {
        for (backgroundName, background) in Self.backgrounds(theme) {
            for (foregroundName, foreground) in Self.foregrounds(theme) {
                expectReadable(foreground, on: background, "\(foregroundName) on \(backgroundName)", theme: theme)
            }
        }
    }

    @Test(arguments: PaletteTheme.all)
    func `button labels are readable on the brand and danger colors`(theme: PaletteTheme) {
        expectReadable(theme.onBrand, on: theme.brand, "onBrand on brand", theme: theme)
        expectReadable(theme.onDanger, on: theme.danger, "onDanger on danger", theme: theme)
    }

    @Test(arguments: PaletteTheme.all)
    func `badge and banner text is readable on its soft background`(theme: PaletteTheme) {
        for pair in Self.softPairs(theme) {
            expectReadable(pair.strong, on: pair.soft, "\(pair.name) on \(pair.name)Soft", theme: theme)
            expectReadable(theme.textPrimary, on: pair.soft, "textPrimary on \(pair.name)Soft", theme: theme)
        }
    }

    @Test(arguments: PaletteTheme.all)
    func `every token changes between light and dark mode`(theme: PaletteTheme) {
        let soft = Self.softPairs(theme).map { ("\($0.name)Soft", $0.soft) }
        let labels = [("onBrand", theme.onBrand), ("onDanger", theme.onDanger)]
        for (name, token) in Self.backgrounds(theme) + Self.foregrounds(theme) + soft + labels {
            #expect(token.light != token.dark, "\(theme.name): \(name) is the same in light and dark mode")
        }
    }

    @Test(arguments: PaletteTheme.all)
    func `the status colors and the brand look different from each other`(theme: PaletteTheme) {
        let colors = [theme.brand, theme.success, theme.warning, theme.danger, theme.info, theme.textSecondary]
        #expect(Set(colors.map { "\($0.light)" }).count == colors.count, "\(theme.name) (light)")
        #expect(Set(colors.map { "\($0.dark)" }).count == colors.count, "\(theme.name) (dark)")
    }

    @Test
    func `themes are found by id, and the standard one is blush and plum`() {
        #expect(PaletteTheme.all.map(\.id) == PaletteTheme.Key.allCases)
        for id in PaletteTheme.Key.allCases {
            #expect(PaletteTheme.with(id: id).id == id)
        }
        #expect(PaletteTheme.standard.id == .blushPlum)
        #expect(Palette.theme.id == .blushPlum)
    }
}

struct MetricsTests {
    @Test
    func `the spacing scale strictly increases`() {
        #expect(Spacing.scale == Spacing.scale.sorted())
        #expect(Set(Spacing.scale).count == Spacing.scale.count)
    }

    @Test
    func `spacing sits on the 8-point grid, with 4-point half steps`() {
        for step in Spacing.scale {
            #expect(step.truncatingRemainder(dividingBy: 4) == 0, "\(step) is off the grid")
        }
        for step in Spacing.scale where step >= Spacing.md {
            #expect(step.truncatingRemainder(dividingBy: 8) == 0, "\(step) is not a multiple of 8")
        }
    }

    @Test
    func `corner radii strictly increase`() {
        #expect(Radius.scale == Radius.scale.sorted())
        #expect(Set(Radius.scale).count == Radius.scale.count)
    }

    @Test
    func `controls meet the minimum tap target`() {
        #expect(Layout.buttonHeight >= Layout.minimumTapTarget)
        #expect(Layout.compactButtonHeight >= Layout.minimumTapTarget)
        #expect(Layout.shutterSize >= Layout.minimumTapTarget)
    }
}

struct StatusToneTests {
    @Test
    func `only success looks done`() {
        #expect(StatusTone.allCases.filter(\.looksDone) == [.success])
    }

    @Test
    func `failures, actions, and work in progress never use the success color`() {
        for tone in StatusTone.allCases where tone != .success {
            #expect(tone.color != Palette.success, "\(tone) uses the success color")
            #expect(tone.softColor != Palette.successSoft, "\(tone) uses the success background")
        }
    }

    @Test
    func `every tone's color is readable on its own background`() {
        for tone in StatusTone.allCases {
            #expect(tone.color.light.contrastRatio(with: tone.softColor.light) >= 4.5, "\(tone) (light)")
            #expect(tone.color.dark.contrastRatio(with: tone.softColor.dark) >= 4.5, "\(tone) (dark)")
        }
    }

    @Test
    func `the tones look different from each other`() {
        let distinct: [StatusTone] = [.success, .inProgress, .failed, .actionNeeded, .neutral]
        #expect(Set(distinct.map(\.systemImage)).count == distinct.count)
        #expect(Set(distinct.map { "\($0.color.light)" }).count == distinct.count)
    }
}
