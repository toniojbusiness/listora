import CoreText
import Foundation

/// The wordmark's typeface: Fraunces (SIL Open Font License, `Resources/Fonts/OFL.txt`), a static
/// instance at the 72 pt optical size, weight 700, fully soft (SOFT 100) and not wonky (WONK 0),
/// as the Looptag concept set it. It is bundled with the package and registered for this process
/// only, the first time a wordmark asks for it. Only the wordmark uses it; the type scale stays
/// SF Pro and New York (`Typography`).
enum BrandFont {
    /// The PostScript name the bundled file declares.
    static let postScriptName = "Fraunces-72ptSuperSoftBoldNonWonky"
    static let fileName = "Fraunces-72ptSuperSoftBoldNonWonky"

    /// The font's license, bundled next to it.
    static let licenseURL = Bundle.module.url(forResource: "OFL", withExtension: "txt", subdirectory: "Fonts")

    /// Whether the font is registered; registering runs once, on first use.
    static let isRegistered: Bool = {
        guard let url = Bundle.module.url(forResource: fileName, withExtension: "ttf", subdirectory: "Fonts") else {
            return false
        }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            return true
        }
        // Already registered (another bundle copy of the package in the same process) is fine.
        let code = error.map { CFErrorGetCode($0.takeRetainedValue()) }
        return code == CTFontManagerError.alreadyRegistered.rawValue
    }()

    /// The font at `size` points. Core Text substitutes a system font only if the bundled file is
    /// missing, which `BrandTests` rules out.
    static func font(size: CGFloat) -> CTFont {
        _ = isRegistered
        return CTFontCreateWithName(postScriptName as CFString, size, nil)
    }
}
