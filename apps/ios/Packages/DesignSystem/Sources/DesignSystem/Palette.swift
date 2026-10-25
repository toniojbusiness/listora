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

/// Listora's semantic colors, from the active ``theme`` (``PaletteTheme``). Views use these
/// names, never raw values, so light and dark mode and every theme stay consistent.
/// `PaletteTests` checks every text and background pair of every theme for WCAG AA contrast
/// (4.5:1), in both modes.
///
/// Each status tone has a strong color for text and icons and a soft color for the background of
/// badges and banners; the strong color is readable on the soft one.
public enum Palette {
    /// Backgrounds, from the screen up: `background` behind everything, `surface` for cards and
    /// rows, `surfaceSecondary` for wells inside a card (text fields, placeholders, chips).
    public static var background: ColorToken {
        theme.background
    }

    public static var surface: ColorToken {
        theme.surface
    }

    public static var surfaceSecondary: ColorToken {
        theme.surfaceSecondary
    }

    public static var separator: ColorToken {
        theme.separator
    }

    /// Text
    public static var textPrimary: ColorToken {
        theme.textPrimary
    }

    public static var textSecondary: ColorToken {
        theme.textSecondary
    }

    /// Brand
    public static var brand: ColorToken {
        theme.brand
    }

    /// A brand-tinted background: selected chips, icon tiles, highlights.
    public static var brandSoft: ColorToken {
        theme.brandSoft
    }

    public static var onBrand: ColorToken {
        theme.onBrand
    }

    /// Status, matching the states users see. Only `success` means done, and it is used only for
    /// what an API read-back or the user confirmed (see `StatusBadge`).
    public static var success: ColorToken {
        theme.success
    }

    public static var successSoft: ColorToken {
        theme.successSoft
    }

    public static var warning: ColorToken {
        theme.warning
    }

    public static var warningSoft: ColorToken {
        theme.warningSoft
    }

    public static var danger: ColorToken {
        theme.danger
    }

    public static var dangerSoft: ColorToken {
        theme.dangerSoft
    }

    /// Labels on a `danger` fill (destructive buttons).
    public static var onDanger: ColorToken {
        theme.onDanger
    }

    public static var info: ColorToken {
        theme.info
    }

    public static var infoSoft: ColorToken {
        theme.infoSoft
    }

    // Media: the camera and the crop screen show photos edge to edge on black in both modes, with
    // white controls on top. `scrim` (used translucent) dims the parts of a photo being cut away
    // and backs controls laid over a photo.
    public static let mediaBackground = ColorToken(light: 0x000000, dark: 0x000000)
    public static let onMedia = ColorToken(light: 0xFFFFFF, dark: 0xFFFFFF)
    public static let scrim = ColorToken(light: 0x000000, dark: 0x000000)

    /// Shadows under raised elements. Shadows barely show on dark backgrounds, so dark mode relies
    /// on the surfaces' lighter tone and hairline borders instead.
    public static var shadow: ColorToken {
        theme.shadow
    }
}
