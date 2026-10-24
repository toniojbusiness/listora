import CoreGraphics

/// Spacing scale in points. Layouts use these steps instead of ad hoc numbers.
public enum Spacing {
    public static let xxs: CGFloat = 4
    public static let xs: CGFloat = 8
    public static let sm: CGFloat = 12
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
    public static let xxl: CGFloat = 48

    static let scale = [xxs, xs, sm, md, lg, xl, xxl]
}

/// Corner radii in points.
public enum Radius {
    public static let small: CGFloat = 8
    public static let medium: CGFloat = 12
    public static let large: CGFloat = 20
}

/// Minimum sizes that keep controls easy to hit.
public enum Layout {
    /// Apple's minimum touch target.
    public static let minimumTapTarget: CGFloat = 44
    public static let buttonHeight: CGFloat = 50
}
