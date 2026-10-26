import Foundation

/// What the user shared to the Share Extension: only the URLs, text, and title the sharing app
/// attached. Listora never loads the shared page, so this is everything it knows about it.
public struct SharedContent: Equatable, Sendable {
    public var urls: [URL]
    public var text: String?
    public var title: String?

    public init(urls: [URL] = [], text: String? = nil, title: String? = nil) {
        self.urls = urls
        self.text = text
        self.title = title
    }

    /// The best reading of the share: the first listing among the shared URLs and the links in
    /// the text; otherwise the first marketplace page that is not a listing; otherwise
    /// `unsupported`.
    public var listingParse: ListingURLParse {
        let parses = candidateURLs.map(ListingURLParse.init)
        if let listing = parses.first(where: {
            if case .listing = $0 {
                true
            } else {
                false
            }
        }) {
            return listing
        }
        if let page = parses.first(where: {
            if case .notListing = $0 {
                true
            } else {
                false
            }
        }) {
            return page
        }
        return .unsupported
    }

    /// A title for a new item, from the shared title or text: links removed, whitespace
    /// collapsed, and a trailing marketplace name (`... | Poshmark`) dropped. The user confirms it.
    public var suggestedTitle: String? {
        for source in [title, text] {
            guard let source else { continue }
            var candidate = source
            for match in Self.linkMatches(in: source).reversed() {
                if let range = Range(match.range, in: candidate) {
                    candidate.replaceSubrange(range, with: " ")
                }
            }
            candidate = candidate.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            for marketplace in ListingMarketplace.allCases {
                for separator in [" | ", " - ", " – "] {
                    let suffix = "\(separator)\(marketplace.displayName)"
                    if candidate.lowercased().hasSuffix(suffix.lowercased()) {
                        candidate = String(candidate.dropLast(suffix.count))
                    }
                }
            }
            candidate = candidate.trimmingCharacters(in: Self.titleEdges)
            if !candidate.isEmpty {
                return String(candidate.prefix(Self.maxTitleLength))
            }
        }
        return nil
    }

    /// The contract's limit for an item title.
    public static let maxTitleLength = 200

    /// Left over at a title's edges once links are removed, as in "Check this out: <link>".
    private static let titleEdges = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ":|-–"))

    /// The shared URLs, then the links in the shared text.
    var candidateURLs: [URL] {
        urls + Self.links(in: text ?? "")
    }

    /// The links in `text`, in order.
    static func links(in text: String) -> [URL] {
        linkMatches(in: text).compactMap(\.url)
    }

    private static func linkMatches(in text: String) -> [NSTextCheckingResult] {
        guard !text.isEmpty, let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        else { return [] }
        return detector.matches(in: text, range: NSRange(text.startIndex ..< text.endIndex, in: text))
    }
}
