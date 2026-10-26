import SwiftUI

/// The type scale: SF Pro on Dynamic Type text styles, so every style scales with the user's text
/// size setting. The two display styles, `largeTitle` and `title` (a screen's own heading, an
/// empty state, a welcome step), are New York (serif) for a refined look; everything inside cards
/// and rows, card headings and prices included, is SF Pro.
///
/// | Style        | Text style   | Weight   | Use                                      |
/// | ------------ | ------------ | -------- | ---------------------------------------- |
/// | `largeTitle` | Large Title  | Bold     | Hero numbers and screen-level headings   |
/// | `title`      | Title 2      | Semibold | Empty states, sheet headings             |
/// | `title3`     | Title 3      | Semibold | Card headings                            |
/// | `headline`   | Headline     | Semibold | Row titles, buttons                      |
/// | `number`     | Headline     | Semibold | Amounts in rows, tabular digits          |
/// | `body`       | Body         | Regular  | Paragraphs, field values                 |
/// | `callout`    | Callout      | Regular  | Supporting text in cards                 |
/// | `code`       | Callout      | Regular  | Text read off a tag, monospaced          |
/// | `subheadline`| Subheadline  | Regular  | Row subtitles                            |
/// | `emphasis`   | Subheadline  | Semibold | Values, inline actions, tabular digits   |
/// | `footnote`   | Footnote     | Regular  | Hints under controls                     |
/// | `metadata`   | Footnote     | Regular  | SKUs, counts, and dates, tabular digits  |
/// | `smallEmphasis` | Footnote  | Semibold | Small values and links, tabular digits   |
/// | `caption`    | Caption 1    | Regular  | Metadata (counts, times)                 |
/// | `label`      | Caption 1    | Semibold | Badges and chips                         |
/// | `eyebrow`    | Footnote     | Semibold | Section headers (shown in capitals)      |
/// | `price`      | Title 3      | Semibold | Prices in lists, tabular digits          |
/// | `priceLarge` | Large Title  | Bold     | The price being entered, tabular digits  |
///
/// These are the only styles: views never add a weight or a digit style of their own, so the same
/// kind of text looks the same on every screen.
public enum Typography {
    public static let largeTitle = Font.system(.largeTitle, design: .serif, weight: .bold)
    public static let title = Font.system(.title2, design: .serif, weight: .semibold)
    public static let title3 = Font.title3.weight(.semibold)

    public static let headline = Font.headline
    /// Amounts in rows and summaries: digits line up.
    public static let number = Font.headline.monospacedDigit()
    public static let body = Font.body
    public static let callout = Font.callout
    /// Text as read off a tag or label, character for character.
    public static let code = Font.callout.monospaced()
    public static let subheadline = Font.subheadline
    /// A value next to its label, an inline action, or a short emphasized line.
    public static let emphasis = Font.subheadline.weight(.semibold).monospacedDigit()
    public static let footnote = Font.footnote
    /// SKUs, counts, and dates in rows: digits line up.
    public static let metadata = Font.footnote.monospacedDigit()
    /// A small value or link beside footnote text.
    public static let smallEmphasis = Font.footnote.weight(.semibold).monospacedDigit()
    public static let caption = Font.caption
    /// Short labels on badges and chips.
    public static let label = Font.caption.weight(.semibold)
    /// Section headers; pair with `.textCase(.uppercase)` (``SectionHeader`` does).
    public static let eyebrow = Font.footnote.weight(.semibold)
    /// Prices and counts: digits line up in lists.
    public static let price = Font.title3.weight(.semibold).monospacedDigit()
    /// A price being entered or the headline price of an item.
    public static let priceLarge = Font.largeTitle.weight(.bold).monospacedDigit()
}
