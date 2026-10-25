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
        let light = light.uiColor
        let dark = dark.uiColor
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
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
/// The brand is a deep teal. Each status tone has a strong color for text and icons and a soft
/// color for the background of badges and banners; the strong color is readable on the soft one.
public enum Palette {
    // Backgrounds, from the screen up: `background` behind everything, `surface` for cards and
    // rows, `surfaceSecondary` for wells inside a card (text fields, placeholders, chips).
    public static let background = ColorToken(light: 0xF4F5F7, dark: 0x0B0D10)
    public static let surface = ColorToken(light: 0xFFFFFF, dark: 0x16191D)
    public static let surfaceSecondary = ColorToken(light: 0xEBEDF0, dark: 0x22262C)
    public static let separator = ColorToken(light: 0xDCDFE4, dark: 0x2C3138)

    // Text
    public static let textPrimary = ColorToken(light: 0x111418, dark: 0xF3F5F7)
    public static let textSecondary = ColorToken(light: 0x4B5361, dark: 0xA3ABB7)

    /// Brand
    public static let brand = ColorToken(light: 0x0B7268, dark: 0x2DD4BF)
    /// A brand-tinted background: selected chips, icon tiles, highlights.
    public static let brandSoft = ColorToken(light: 0xDDF3EF, dark: 0x0D3532)
    public static let onBrand = ColorToken(light: 0xFFFFFF, dark: 0x032B28)

    // Status, matching the states users see. Only `success` means done, and it is used only for
    // what an API read-back or the user confirmed (see `StatusBadge`).
    public static let success = ColorToken(light: 0x157A3E, dark: 0x4ADE80)
    public static let successSoft = ColorToken(light: 0xE2F5E9, dark: 0x0E3220)
    public static let warning = ColorToken(light: 0x9A4806, dark: 0xFBBF24)
    public static let warningSoft = ColorToken(light: 0xFDF0DF, dark: 0x372807)
    public static let danger = ColorToken(light: 0xB42318, dark: 0xFF8A80)
    public static let dangerSoft = ColorToken(light: 0xFDE9E7, dark: 0x3D1513)
    /// Labels on a `danger` fill (destructive buttons).
    public static let onDanger = ColorToken(light: 0xFFFFFF, dark: 0x2B0806)
    public static let info = ColorToken(light: 0x1D5FC2, dark: 0x7CB4FF)
    public static let infoSoft = ColorToken(light: 0xE6EFFC, dark: 0x12294A)

    // Media: the camera and the crop screen show photos edge to edge on black in both modes, with
    // white controls on top. `scrim` (used translucent) dims the parts of a photo being cut away
    // and backs controls laid over a photo.
    public static let mediaBackground = ColorToken(light: 0x000000, dark: 0x000000)
    public static let onMedia = ColorToken(light: 0xFFFFFF, dark: 0xFFFFFF)
    public static let scrim = ColorToken(light: 0x000000, dark: 0x000000)

    /// Shadows under raised elements. Shadows barely show on dark backgrounds, so dark mode relies
    /// on the surfaces' lighter tone and hairline borders instead.
    public static let shadow = ColorToken(light: 0x0B1F33, dark: 0x000000)
}
