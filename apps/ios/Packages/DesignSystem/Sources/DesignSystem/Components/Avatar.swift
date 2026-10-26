import SwiftUI
import UIKit

/// The seller's picture: their photo cropped to a circle, or their initials on the brand's soft
/// clay, or a person symbol when there are no initials yet. Decorative, so VoiceOver skips it; the
/// control or row it sits in says whose it is.
public struct Avatar: View {
    public enum Size: Sendable {
        /// 32 points, the header button that opens the profile.
        case toolbar
        /// 44 points, a list row.
        case row
        /// 88 points, the top of the profile.
        case large

        var side: CGFloat {
            switch self {
            case .toolbar: 32
            case .row: 44
            case .large: 88
            }
        }

        var font: Font {
            switch self {
            case .toolbar: .footnote.weight(.semibold)
            case .row: .body.weight(.semibold)
            case .large: .system(size: 34, weight: .semibold, design: .serif)
            }
        }
    }

    private let initials: String
    private let image: UIImage?
    private let size: Size
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    /// `initials`: one or two letters (``Avatar/initials(for:)``); empty shows the person symbol.
    public init(initials: String, image: UIImage? = nil, size: Size = .row) {
        self.initials = initials
        self.image = image
        self.size = size
    }

    public var body: some View {
        // The header button keeps the bar's height; rows and the profile grow with the text.
        let side = size == .toolbar ? size.side : size.side * min(scale, 1.4)
        ZStack {
            Circle().fill(Palette.brandSoft.color)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if initials.isEmpty {
                Image(systemName: "person.fill")
                    .font(size.font)
                    .foregroundStyle(Palette.brand)
            } else {
                Text(initials)
                    .font(size.font)
                    .foregroundStyle(Palette.brand)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
            }
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Palette.separator.color, lineWidth: image == nil ? 0 : 1))
        .accessibilityHidden(true)
    }

    /// Up to two capital letters from the first name that has any: "Sam Rivera" is "SR", "Second
    /// Spin Vintage" is "SS", "sam@example.com" is "S".
    public static func initials(for names: [String?]) -> String {
        for name in names {
            guard let name else { continue }
            let local = name.split(separator: "@").first.map(String.init) ?? name
            let words = local.split { !$0.isLetter && !$0.isNumber }
            let letters = words.prefix(2).compactMap(\.first)
            if !letters.isEmpty {
                return String(name.contains("@") ? letters.prefix(1) : letters[...]).uppercased()
            }
        }
        return ""
    }
}

#Preview {
    HStack(spacing: Spacing.md) {
        Avatar(initials: "SR", size: .toolbar)
        Avatar(initials: "", size: .row)
        Avatar(initials: "SS", size: .large)
    }
    .padding()
    .background(Palette.background)
}
