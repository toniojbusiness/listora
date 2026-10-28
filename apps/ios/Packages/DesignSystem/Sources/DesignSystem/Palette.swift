import SwiftUI
import UIKit

/// An sRGB color given as 0xRRGGBB.
public struct RGB: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(hex: UInt32) {
        red = Double((hex >> 16) & 0xFF) / 255
        green = Double((hex >> 8) & 0xFF) / 255
        blue = Double(hex & 0xFF) / 255
    }

    /// WCAG 2.x relative luminance.
    public var relativeLuminance: Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.040_45 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    /// WCAG 2.x contrast ratio, from 1 (identical) to 21 (black on white).
    public func contrastRatio(with other: RGB) -> Double {
        let lighter = max(relativeLuminance, other.relativeLuminance)
        let darker = min(relativeLuminance, other.relativeLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    var uiColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
}

/// A semantic color with one value for light mode and one for dark mode. Use it directly as a
/// `ShapeStyle` (`.foregroundStyle(Palette.textPrimary)`) or through `color` where an API needs
/// a `Color`. Both adapt to the current appearance.
public struct ColorToken: Equatable, Sendable, ShapeStyle {
    public let light: RGB
    public let dark: RGB

    public init(light: UInt32, dark: UInt32) {
        self.light = RGB(hex: light)
        self.dark = RGB(hex: dark)
    }

    public var color: Color {
        Color(uiColor: uiColor)
    }

    /// The token as a `UIColor` that adapts to the appearance.
    var uiColor: UIColor {
        let light = light.uiColor
        let dark = dark.uiColor
        return UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
    }

    public func resolve(in environment: EnvironmentValues) -> Color {
        let rgb = environment.colorScheme == .dark ? dark : light
        return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
}

/// Listora's semantic colors. Views use these names, never raw values, so light and dark mode
/// stay consistent. `PaletteTests` checks every text and background pair for WCAG AA contrast
/// (4.5:1), in both modes.
///
/// Forest and clay: a terracotta-clay brand, forest-green text on warm off-white surfaces, and
/// deep forest surfaces in dark mode. Each status tone has a strong color for text and icons and
/// a soft color for the background of badges and banners; the strong color is readable on the
/// soft one.
public enum Palette {
    /// Backgrounds, from the screen up: `background` behind everything, `surface` for cards and
    /// rows, `surfaceSecondary` for wells inside a card (text fields, placeholders, chips).
    public static let background = ColorToken(light: 0xF7F4EE, dark: 0x0F1913)

    public static let surface = ColorToken(light: 0xFFFDF9, dark: 0x16231B)

    public static let surfaceSecondary = ColorToken(light: 0xEEE9DF, dark: 0x1F2E25)

    public static let separator = ColorToken(light: 0xE0D9CC, dark: 0x2C3D32)

    /// Text
    public static let textPrimary = ColorToken(light: 0x17281E, dark: 0xEEF2EC)

    public static let textSecondary = ColorToken(light: 0x4C5D52, dark: 0xADBDB2)

    /// Brand
    public static let brand = ColorToken(light: 0x9C472A, dark: 0xEFA484)

    /// A brand-tinted background: selected chips, icon tiles, highlights.
    public static let brandSoft = ColorToken(light: 0xF5E2D8, dark: 0x43271B)

    public static let onBrand = ColorToken(light: 0xFFFFFF, dark: 0x34150A)

    /// Status, matching the states users see. Only `success` means done, and it is used only for
    /// what an API read-back or the user confirmed (see `StatusBadge`).
    public static let success = ColorToken(light: 0x1F6A3E, dark: 0x8CD6A6)

    public static let successSoft = ColorToken(light: 0xE1F0E5, dark: 0x16311F)

    public static let warning = ColorToken(light: 0x7F5000, dark: 0xEDC476)

    public static let warningSoft = ColorToken(light: 0xF6ECD5, dark: 0x382C12)

    public static let danger = ColorToken(light: 0xA8203F, dark: 0xFF9DB0)

    public static let dangerSoft = ColorToken(light: 0xF9E2E7, dark: 0x461723)

    /// Labels on a `danger` fill (destructive buttons).
    public static let onDanger = ColorToken(light: 0xFFFFFF, dark: 0x3A0A16)

    public static let info = ColorToken(light: 0x37587A, dark: 0xA7C2DE)

    public static let infoSoft = ColorToken(light: 0xE4EBF2, dark: 0x1B2A36)

    // Media: the camera and the crop screen show photos edge to edge on black in both modes, with
    // white controls on top. `scrim` (used translucent) dims the parts of a photo being cut away
    // and backs controls laid over a photo.
    public static let mediaBackground = ColorToken(light: 0x000000, dark: 0x000000)
    public static let onMedia = ColorToken(light: 0xFFFFFF, dark: 0xFFFFFF)
    public static let scrim = ColorToken(light: 0x000000, dark: 0x000000)

    /// Shadows under raised elements. Shadows barely show on dark backgrounds, so dark mode relies
    /// on the surfaces' lighter tone and hairline borders instead.
    public static let shadow = ColorToken(light: 0x17281E, dark: 0x000000)

    // Hang Tag: the price-tag materials. Each item is a tag on the Looptag string; the string ties
    // together what belongs together (the day's cards, an item's marketplaces). `thread` and
    // `rail` carry meaning, so they reach the 3:1 contrast of meaningful graphics on every
    // background (`PaletteTests`); `stitch` and `eyelet` are decoration and stay quiet.

    /// The string: through the eyelets of the day's cards, and from an item to its marketplaces.
    public static let thread = ColorToken(light: 0x3C5446, dark: 0x8FA597)

    /// The rail the tags hang from: above the tab bar and an empty state's tag.
    public static let rail = ColorToken(light: 0x7A5C3E, dark: 0xA88A68)

    /// The stitched edge just inside a tag, a label, or a filled button's border.
    public static let stitch = ColorToken(light: 0xCDC2AE, dark: 0x3D5244)

    /// The brass ring around a tag's punched eyelet.
    public static let eyelet = ColorToken(light: 0xD3C29F, dark: 0x6E5E44)
}
