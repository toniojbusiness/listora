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
/// stay consistent. `PaletteTests` checks every text and background pair for WCAG AA contrast.
public enum Palette {
    // Backgrounds
    public static let background = ColorToken(light: 0xF7F7F5, dark: 0x0E0F11)
    public static let surface = ColorToken(light: 0xFFFFFF, dark: 0x1A1C1F)
    public static let surfaceSecondary = ColorToken(light: 0xEFEFEC, dark: 0x24272B)
    public static let separator = ColorToken(light: 0xE2E2DE, dark: 0x2E3236)

    // Text
    public static let textPrimary = ColorToken(light: 0x16181B, dark: 0xF2F3F5)
    public static let textSecondary = ColorToken(light: 0x5B6068, dark: 0xA3A8B0)

    // Brand
    public static let brand = ColorToken(light: 0x0F766E, dark: 0x2DD4BF)
    public static let onBrand = ColorToken(light: 0xFFFFFF, dark: 0x042F2E)

    // Status, matching the operation states users see (confirmed, needs action, failed)
    public static let success = ColorToken(light: 0x15753A, dark: 0x4ADE80)
    public static let warning = ColorToken(light: 0xA84D08, dark: 0xFBBF24)
    public static let danger = ColorToken(light: 0xB91C1C, dark: 0xF87171)
}
