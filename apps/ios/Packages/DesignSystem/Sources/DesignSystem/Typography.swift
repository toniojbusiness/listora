import SwiftUI

/// The type scale, on Dynamic Type text styles, so every style scales with the user's text size
/// setting. The display styles are Fraunces, the print on a price tag (`BrandFont`): a screen's
/// own heading and an empty state (`largeTitle`, `title`) and prices (`price`, `priceLarge`).
/// Everything you read inside cards and rows is SF Pro, card headings included. Fraunces has no
/// tabular figures, so an amount being typed (`amountEntry`) and the keypad's keys (`keypad`)
/// stay SF Pro with digits that hold still.
///
/// | Style        | Text style   | Font     | Weight   | Use                                      |
/// | ------------ | ------------ | -------- | -------- | ---------------------------------------- |
/// | `largeTitle` | Large Title  | Fraunces | Bold     | Hero numbers and screen-level headings   |
/// | `title`      | Title 2      | Fraunces | Bold     | Empty states, sheet headings             |
/// | `title3`     | Title 3      | SF Pro   | Semibold | Card headings                            |
/// | `headline`   | Headline     | SF Pro   | Semibold | Row titles, buttons                      |
/// | `number`     | Headline     | SF Pro   | Semibold | Amounts in rows, tabular digits          |
/// | `body`       | Body         | SF Pro   | Regular  | Paragraphs, field values                 |
/// | `callout`    | Callout      | SF Pro   | Regular  | Supporting text in cards                 |
/// | `code`       | Callout      | SF Mono  | Regular  | Text read off a tag                      |
/// | `subheadline`| Subheadline  | SF Pro   | Regular  | Row subtitles                            |
/// | `emphasis`   | Subheadline  | SF Pro   | Semibold | Values, inline actions, tabular digits   |
/// | `footnote`   | Footnote     | SF Pro   | Regular  | Hints under controls                     |
/// | `metadata`   | Footnote     | SF Pro   | Regular  | SKUs, counts, and dates, tabular digits  |
/// | `smallEmphasis` | Footnote  | SF Pro   | Semibold | Small values and links, tabular digits   |
/// | `caption`    | Caption 1    | SF Pro   | Regular  | Metadata (counts, times)                 |
/// | `label`      | Caption 1    | SF Pro   | Semibold | Badges and chips                         |
/// | `stamp`      | Caption 2    | SF Pro   | Heavy    | A stamp's word (shown in capitals)       |
/// | `eyebrow`    | Footnote     | SF Pro   | Semibold | Section headers (shown in capitals)      |
/// | `price`      | Title 3      | Fraunces | Bold     | Prices on cards and in lists             |
/// | `priceLarge` | Large Title  | Fraunces | Bold     | The headline price of an item or a day   |
/// | `amountEntry`| Large Title  | SF Pro   | Bold     | An amount or code being typed, tabular   |
/// | `keypad`     | Title 3      | SF Pro   | Semibold | The keys of a number keypad, tabular     |
///
/// These are the only styles: views never add a weight or a digit style of their own, so the same
/// kind of text looks the same on every screen.
public enum Typography {
    public static let largeTitle = BrandFont.display(size: 34, relativeTo: .largeTitle)
    public static let title = BrandFont.display(size: 22, relativeTo: .title2)
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
    /// The one word of a stamp ("Urgent", "Sold"); pair with `.textCase(.uppercase)` (``Stamp`` does).
    public static let stamp = Font.caption2.weight(.heavy)
    /// Section headers; pair with `.textCase(.uppercase)` (``SectionHeader`` does).
    public static let eyebrow = Font.footnote.weight(.semibold)
    /// A price on a card or in a list, printed like a tag's.
    public static let price = BrandFont.display(size: 20, relativeTo: .title3)
    /// The headline price of an item, a sale, or the day.
    public static let priceLarge = BrandFont.display(size: 34, relativeTo: .largeTitle)
    /// An amount or a code while it is being typed: digits hold still as they change.
    public static let amountEntry = Font.largeTitle.weight(.bold).monospacedDigit()
    /// The keys of a number keypad.
    public static let keypad = Font.title3.weight(.semibold).monospacedDigit()
}
