import SwiftUI

/// The type scale: SF Pro on Dynamic Type text styles, so every style scales with the user's text
/// size setting. The three title styles follow the theme's heading design (New York in the serif
/// themes); everything else, including prices, stays SF Pro.
///
/// | Style        | Text style   | Weight   | Use                                      |
/// | ------------ | ------------ | -------- | ---------------------------------------- |
/// | `largeTitle` | Large Title  | Bold     | Hero numbers and screen-level headings   |
/// | `title`      | Title 2      | Semibold | Empty states, sheet headings             |
/// | `title3`     | Title 3      | Semibold | Card headings                            |
/// | `headline`   | Headline     | Semibold | Row titles, buttons                      |
/// | `body`       | Body         | Regular  | Paragraphs, field values                 |
/// | `callout`    | Callout      | Regular  | Supporting text in cards                 |
/// | `subheadline`| Subheadline  | Regular  | Row subtitles                            |
/// | `footnote`   | Footnote     | Regular  | Hints under controls                     |
/// | `caption`    | Caption 1    | Regular  | Metadata (counts, times)                 |
/// | `label`      | Caption 1    | Semibold | Badges and chips                         |
/// | `eyebrow`    | Footnote     | Semibold | Section headers (shown in capitals)      |
/// | `price`      | Title 3      | Semibold | Prices in lists, tabular digits          |
/// | `priceLarge` | Large Title  | Bold     | The price being entered, tabular digits  |
public enum Typography {
    public static var largeTitle: Font {
        heading(.largeTitle, .bold)
    }

    public static var title: Font {
        heading(.title2, .semibold)
    }

    public static var title3: Font {
        heading(.title3, .semibold)
    }

    public static let headline = Font.headline
    public static let body = Font.body
    public static let callout = Font.callout
    public static let subheadline = Font.subheadline
    public static let footnote = Font.footnote
    public static let caption = Font.caption
    /// Short labels on badges and chips.
    public static let label = Font.caption.weight(.semibold)
    /// Section headers; pair with `.textCase(.uppercase)` (``SectionHeader`` does).
    public static let eyebrow = Font.footnote.weight(.semibold)
    /// Prices and counts: digits line up in lists.
    public static let price = Font.title3.weight(.semibold).monospacedDigit()
    /// A price being entered or the headline price of an item.
    public static let priceLarge = Font.largeTitle.weight(.bold).monospacedDigit()

    /// A heading style in the active theme's heading design (New York or SF Pro).
    private static func heading(_ style: Font.TextStyle, _ weight: Font.Weight) -> Font {
        let design: Font.Design = Palette.theme.headingDesign == .serif ? .serif : .default
        return .system(style, design: design, weight: weight)
    }
}
