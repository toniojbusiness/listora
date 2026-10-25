import CoreGraphics

/// Spacing on an 8-point grid, in points. Layouts use these steps instead of ad hoc numbers.
/// `xxs` (4) and `sm` (12) are the grid's half steps, for spacing inside small components.
public enum Spacing {
    public static let xxs: CGFloat = 4
    public static let xs: CGFloat = 8
    public static let sm: CGFloat = 12
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
    public static let xxl: CGFloat = 48
    public static let xxxl: CGFloat = 64

    static let scale = [xxs, xs, sm, md, lg, xl, xxl, xxxl]
}

/// Corner radii in points. Nested shapes use a smaller radius than their container.
public enum Radius {
    /// Thumbnails, chips inside cards, small wells.
    public static let small: CGFloat = 8
    /// Buttons, text fields, photo tiles.
    public static let medium: CGFloat = 12
    /// Cards and banners.
    public static let large: CGFloat = 20
    /// Sheets and the bottom action bar's top edge.
    public static let extraLarge: CGFloat = 28

    static let scale = [small, medium, large, extraLarge]
}

/// Minimum sizes that keep controls easy to hit.
public enum Layout {
    /// Apple's minimum touch target.
    public static let minimumTapTarget: CGFloat = 44
    /// A full-width button.
    public static let buttonHeight: CGFloat = 52
    /// A compact button, such as Retry inside a banner. Still meets the tap target.
    public static let compactButtonHeight: CGFloat = 44
    /// The camera's shutter.
    public static let shutterSize: CGFloat = 84
    /// Readable line length for text-heavy screens on large phones.
    public static let readableWidth: CGFloat = 560
}
