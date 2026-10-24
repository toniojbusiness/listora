import SwiftUI

/// Text styles. Every style is built on a Dynamic Type text style, so it scales with the user's
/// text size setting. Titles use the default design so they match system navigation titles.
public enum Typography {
    public static let largeTitle = Font.largeTitle.weight(.bold)
    public static let title = Font.title2.weight(.semibold)
    public static let headline = Font.headline
    public static let body = Font.body
    public static let callout = Font.callout
    public static let caption = Font.caption
    /// Prices and counts: digits line up in lists.
    public static let price = Font.title3.weight(.semibold).monospacedDigit()
}
