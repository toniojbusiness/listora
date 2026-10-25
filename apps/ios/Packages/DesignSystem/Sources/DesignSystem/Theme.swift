import os
import SwiftUI

/// A complete set of Listora's semantic colors, plus the design of its headings. The app has one
/// active theme (``Palette/theme``); every `Palette` name reads from it. Every theme meets the
/// same WCAG AA rules (`PaletteTests` checks each one), and only `success` reads as done.
///
/// Three directions are under consideration; Dev builds can switch between them in Settings, and
/// every other build uses ``standard``.
public struct PaletteTheme: Equatable, Identifiable, Sendable {
    public enum Key: String, CaseIterable, Sendable {
        case blushPlum
        case sageSand
        case terracottaCream
    }

    /// How large titles are drawn: New York (serif) or SF Pro.
    public enum HeadingDesign: Sendable {
        case serif
        case standard
    }

    public let id: Key
    public let name: String
    public let headingDesign: HeadingDesign

    public let background: ColorToken
    public let surface: ColorToken
    public let surfaceSecondary: ColorToken
    public let separator: ColorToken
    public let textPrimary: ColorToken
    public let textSecondary: ColorToken
    public let brand: ColorToken
    public let brandSoft: ColorToken
    public let onBrand: ColorToken
    public let success: ColorToken
    public let successSoft: ColorToken
    public let warning: ColorToken
    public let warningSoft: ColorToken
    public let danger: ColorToken
    public let dangerSoft: ColorToken
    public let onDanger: ColorToken
    public let info: ColorToken
    public let infoSoft: ColorToken
    public let shadow: ColorToken

    /// The theme every build uses unless a Dev build picks another.
    public static let standard = blushPlum

    public static let all: [PaletteTheme] = [blushPlum, sageSand, terracottaCream]

    public static func with(id: Key) -> PaletteTheme {
        all.first { $0.id == id } ?? standard
    }

    /// Soft blush tints, a deep plum accent, warm ivory surfaces; serif headings.
    public static let blushPlum = PaletteTheme(
        id: .blushPlum,
        name: "Blush and plum",
        headingDesign: .serif,
        background: ColorToken(light: 0xFBF7F4, dark: 0x161013),
        surface: ColorToken(light: 0xFFFDFB, dark: 0x211A1E),
        surfaceSecondary: ColorToken(light: 0xF5ECEA, dark: 0x2D2429),
        separator: ColorToken(light: 0xEADCD8, dark: 0x3A2F35),
        textPrimary: ColorToken(light: 0x2A1B26, dark: 0xF7EEF2),
        textSecondary: ColorToken(light: 0x6B5864, dark: 0xC4B3BD),
        brand: ColorToken(light: 0x6E2A5C, dark: 0xE7A3C9),
        brandSoft: ColorToken(light: 0xF6E3EC, dark: 0x43213A),
        onBrand: ColorToken(light: 0xFFFFFF, dark: 0x2E0F25),
        success: ColorToken(light: 0x2E6B4A, dark: 0x86D3A6),
        successSoft: ColorToken(light: 0xE5F1E9, dark: 0x173224),
        warning: ColorToken(light: 0x8F4A12, dark: 0xF2C27A),
        warningSoft: ColorToken(light: 0xFBEEDD, dark: 0x3B2A12),
        danger: ColorToken(light: 0xA8243B, dark: 0xFF8A7A),
        dangerSoft: ColorToken(light: 0xFBE6EA, dark: 0x47161F),
        onDanger: ColorToken(light: 0xFFFFFF, dark: 0x3A0A14),
        info: ColorToken(light: 0x3D5585, dark: 0xA9BCF0),
        infoSoft: ColorToken(light: 0xE7ECF6, dark: 0x1E2A45),
        shadow: ColorToken(light: 0x2A1B26, dark: 0x000000),
    )

    /// A muted sage accent, warm sand and cream neutrals, espresso text; serif headings.
    public static let sageSand = PaletteTheme(
        id: .sageSand,
        name: "Sage and sand",
        headingDesign: .serif,
        background: ColorToken(light: 0xF6F2EA, dark: 0x14130F),
        surface: ColorToken(light: 0xFFFDF8, dark: 0x1F1D18),
        surfaceSecondary: ColorToken(light: 0xEDE6D9, dark: 0x2A2721),
        separator: ColorToken(light: 0xE0D7C6, dark: 0x38342C),
        textPrimary: ColorToken(light: 0x2B2118, dark: 0xF4EFE6),
        textSecondary: ColorToken(light: 0x65574A, dark: 0xBDB3A4),
        brand: ColorToken(light: 0x4A6650, dark: 0xA9C6A3),
        brandSoft: ColorToken(light: 0xE3EBDF, dark: 0x26332A),
        onBrand: ColorToken(light: 0xFFFFFF, dark: 0x15211A),
        success: ColorToken(light: 0x1F6640, dark: 0x8FD4A8),
        successSoft: ColorToken(light: 0xE2F0E6, dark: 0x173022),
        warning: ColorToken(light: 0x8A4B10, dark: 0xEDC27E),
        warningSoft: ColorToken(light: 0xF8ECD9, dark: 0x3A2C14),
        danger: ColorToken(light: 0xA3352A, dark: 0xF4A193),
        dangerSoft: ColorToken(light: 0xF8E5E1, dark: 0x43201A),
        onDanger: ColorToken(light: 0xFFFFFF, dark: 0x3A120B),
        info: ColorToken(light: 0x3E5C7A, dark: 0xA8C2DC),
        infoSoft: ColorToken(light: 0xE6EDF3, dark: 0x1D2B38),
        shadow: ColorToken(light: 0x2B2118, dark: 0x000000),
    )

    /// A warm terracotta accent, cream surfaces, charcoal text; SF Pro headings.
    public static let terracottaCream = PaletteTheme(
        id: .terracottaCream,
        name: "Terracotta and cream",
        headingDesign: .standard,
        background: ColorToken(light: 0xFAF5EF, dark: 0x151311),
        surface: ColorToken(light: 0xFFFCF8, dark: 0x201D1A),
        surfaceSecondary: ColorToken(light: 0xF2E9DF, dark: 0x2B2723),
        separator: ColorToken(light: 0xE6D9CB, dark: 0x3A342E),
        textPrimary: ColorToken(light: 0x262321, dark: 0xF6F0EA),
        textSecondary: ColorToken(light: 0x5F5852, dark: 0xC0B6AC),
        brand: ColorToken(light: 0xA4492F, dark: 0xF0A487),
        brandSoft: ColorToken(light: 0xF6E2D8, dark: 0x45261B),
        onBrand: ColorToken(light: 0xFFFFFF, dark: 0x3A160B),
        success: ColorToken(light: 0x2F6A47, dark: 0x8ED2A6),
        successSoft: ColorToken(light: 0xE4F0E7, dark: 0x173022),
        warning: ColorToken(light: 0x8A5100, dark: 0xF0C276),
        warningSoft: ColorToken(light: 0xF9EDD6, dark: 0x3B2B12),
        danger: ColorToken(light: 0xA61E3A, dark: 0xFF9BAE),
        dangerSoft: ColorToken(light: 0xFAE3E8, dark: 0x47161F),
        onDanger: ColorToken(light: 0xFFFFFF, dark: 0x3A0A14),
        info: ColorToken(light: 0x3E5A78, dark: 0xA9C0DA),
        infoSoft: ColorToken(light: 0xE6ECF2, dark: 0x1E2A38),
        shadow: ColorToken(light: 0x262321, dark: 0x000000),
    )
}

extension Palette {
    private static let active = OSAllocatedUnfairLock(initialState: PaletteTheme.standard)

    /// The active theme. Set it before the first view draws, or rebuild the views after (the root
    /// view's identity), since views read the colors as they draw.
    public static var theme: PaletteTheme {
        get { active.withLock { $0 } }
        set { active.withLock { $0 = newValue } }
    }
}
