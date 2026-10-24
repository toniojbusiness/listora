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
    ]

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
    func `every token changes between light and dark mode`() {
        for (name, token) in Self.backgrounds + Self.foregrounds + [("onBrand", Palette.onBrand)] {
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
    func `controls meet the minimum tap target`() {
        #expect(Layout.buttonHeight >= Layout.minimumTapTarget)
    }
}
