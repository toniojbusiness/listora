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
/// Blush and plum: soft blush tints, a deep plum brand, warm ivory surfaces, and their deep
/// counterparts in dark mode. Each status tone has a strong color for text and icons and a soft color for the
/// background of
/// badges and banners; the strong color is readable on the soft one.
public enum Palette {
    /// Backgrounds, from the screen up: `background` behind everything, `surface` for cards and
    /// rows, `surfaceSecondary` for wells inside a card (text fields, placeholders, chips).
    public static let background = ColorToken(light: 0xFBF7F4, dark: 0x161013)

    public static let surface = ColorToken(light: 0xFFFDFB, dark: 0x211A1E)

    public static let surfaceSecondary = ColorToken(light: 0xF5ECEA, dark: 0x2D2429)

    public static let separator = ColorToken(light: 0xEADCD8, dark: 0x3A2F35)

    /// Text
    public static let textPrimary = ColorToken(light: 0x2A1B26, dark: 0xF7EEF2)

    public static let textSecondary = ColorToken(light: 0x6B5864, dark: 0xC4B3BD)

    /// Brand
    public static let brand = ColorToken(light: 0x6E2A5C, dark: 0xE7A3C9)

    /// A brand-tinted background: selected chips, icon tiles, highlights.
    public static let brandSoft = ColorToken(light: 0xF6E3EC, dark: 0x43213A)

    public static let onBrand = ColorToken(light: 0xFFFFFF, dark: 0x2E0F25)

    /// Status, matching the states users see. Only `success` means done, and it is used only for
    /// what an API read-back or the user confirmed (see `StatusBadge`).
    public static let success = ColorToken(light: 0x2E6B4A, dark: 0x86D3A6)

    public static let successSoft = ColorToken(light: 0xE5F1E9, dark: 0x173224)

    public static let warning = ColorToken(light: 0x8F4A12, dark: 0xF2C27A)

    public static let warningSoft = ColorToken(light: 0xFBEEDD, dark: 0x3B2A12)

    public static let danger = ColorToken(light: 0xA8243B, dark: 0xFF8A7A)

    public static let dangerSoft = ColorToken(light: 0xFBE6EA, dark: 0x47161F)

    /// Labels on a `danger` fill (destructive buttons).
    public static let onDanger = ColorToken(light: 0xFFFFFF, dark: 0x3A0A14)

    public static let info = ColorToken(light: 0x3D5585, dark: 0xA9BCF0)

    public static let infoSoft = ColorToken(light: 0xE7ECF6, dark: 0x1E2A45)

    // Media: the camera and the crop screen show photos edge to edge on black in both modes, with
    // white controls on top. `scrim` (used translucent) dims the parts of a photo being cut away
    // and backs controls laid over a photo.
    public static let mediaBackground = ColorToken(light: 0x000000, dark: 0x000000)
    public static let onMedia = ColorToken(light: 0xFFFFFF, dark: 0xFFFFFF)
    public static let scrim = ColorToken(light: 0x000000, dark: 0x000000)

    /// Shadows under raised elements. Shadows barely show on dark backgrounds, so dark mode relies
    /// on the surfaces' lighter tone and hairline borders instead.
    public static let shadow = ColorToken(light: 0x2A1B26, dark: 0x000000)
}
