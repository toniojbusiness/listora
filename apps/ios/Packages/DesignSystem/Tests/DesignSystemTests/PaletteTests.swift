import Testing
@testable import DesignSystem

struct PaletteTests {
    /// WCAG AA minimum for normal-size text.
    private static let minimumTextContrast = 4.5

    private static let backgrounds: [(String, ColorToken)] = [
        ("background", Palette.background),
        ("surface", Palette.surface),
        ("surfaceSecondary", Palette.surfaceSecondary),
    ]

    private static let foregrounds: [(String, ColorToken)] = [
        ("textPrimary", Palette.textPrimary),
        ("textSecondary", Palette.textSecondary),
        ("brand", Palette.brand),
        ("success", Palette.success),
        ("warning", Palette.warning),
        ("danger", Palette.danger),
        ("info", Palette.info),
    ]

    /// A tone's strong color and the soft background it sits on.
    private struct SoftPair {
        let name: String
        let strong: ColorToken
        let soft: ColorToken
    }

    private static let softPairs = [
        SoftPair(name: "brand", strong: Palette.brand, soft: Palette.brandSoft),
        SoftPair(name: "success", strong: Palette.success, soft: Palette.successSoft),
        SoftPair(name: "warning", strong: Palette.warning, soft: Palette.warningSoft),
        SoftPair(name: "danger", strong: Palette.danger, soft: Palette.dangerSoft),
        SoftPair(name: "info", strong: Palette.info, soft: Palette.infoSoft),
    ]

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

    @Test
    func `every foreground is readable on every background in light and dark mode`() {
        for (backgroundName, background) in Self.backgrounds {
            for (foregroundName, foreground) in Self.foregrounds {
                let light = foreground.light.contrastRatio(with: background.light)
                let dark = foreground.dark.contrastRatio(with: background.dark)
                #expect(
                    light >= Self.minimumTextContrast,
                    "\(foregroundName) on \(backgroundName) (light) is \(light):1",
                )
                #expect(
                    dark >= Self.minimumTextContrast,
                    "\(foregroundName) on \(backgroundName) (dark) is \(dark):1",
                )
            }
        }
    }

    @Test
    func `button labels are readable on the brand color`() {
        #expect(Palette.onBrand.light.contrastRatio(with: Palette.brand.light) >= Self.minimumTextContrast)
        #expect(Palette.onBrand.dark.contrastRatio(with: Palette.brand.dark) >= Self.minimumTextContrast)
    }

    @Test
    func `badge and banner text is readable on its soft background`() {
        for pair in Self.softPairs {
            for (label, text) in [(pair.name, pair.strong), ("textPrimary", Palette.textPrimary)] {
                let light = text.light.contrastRatio(with: pair.soft.light)
                let dark = text.dark.contrastRatio(with: pair.soft.dark)
                #expect(light >= Self.minimumTextContrast, "\(label) on \(pair.name)Soft (light) is \(light):1")
                #expect(dark >= Self.minimumTextContrast, "\(label) on \(pair.name)Soft (dark) is \(dark):1")
            }
        }
    }

    @Test
    func `destructive button labels are readable on the danger color`() {
        #expect(Palette.onDanger.light.contrastRatio(with: Palette.danger.light) >= Self.minimumTextContrast)
        #expect(Palette.onDanger.dark.contrastRatio(with: Palette.danger.dark) >= Self.minimumTextContrast)
    }

    @Test
    func `every token changes between light and dark mode`() {
        let soft = Self.softPairs.map { ("\($0.name)Soft", $0.soft) }
        let labels = [("onBrand", Palette.onBrand), ("onDanger", Palette.onDanger)]
        for (name, token) in Self.backgrounds + Self.foregrounds + soft + labels {
            #expect(token.light != token.dark, "\(name) is the same in light and dark mode")
        }
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
