import Foundation

/// The privacy policy or the terms of service, read from the Markdown in `docs/legal/` that the
/// app bundles (project.yml), so the app shows the same words as the repository. It reads the
/// subset those files use: headings, paragraphs, bullets (with wrapped lines), quotes, and
/// tables, whose rows the app shows as label and value pairs.
public struct LegalDocument: Equatable, Sendable {
    public enum Block: Equatable, Sendable {
        case heading(String)
        case subheading(String)
        case paragraph(String)
        case bullet(String)
        /// A quoted note, such as the draft warning.
        case note(String)
        /// A table's rows, each as (column heading, cell) pairs.
        case table([[Cell]])
    }

    public struct Cell: Equatable, Sendable {
        public let label: String
        public let value: String
    }

    public enum Kind: String, CaseIterable, Sendable {
        case privacyPolicy = "privacy-policy"
        case termsOfService = "terms-of-service"

        public var title: String {
            switch self {
            case .privacyPolicy: "Privacy policy"
            case .termsOfService: "Terms of service"
            }
        }
    }

    /// The first `#` heading.
    public let title: String
    public let blocks: [Block]

    public init(markdown: String) {
        var parser = Parser()
        for line in markdown.components(separatedBy: .newlines) {
            parser.read(line)
        }
        parser.flush()
        title = parser.title
        blocks = parser.blocks
    }

    /// The bundled document, or nil when the build has none.
    public static func bundled(_ kind: Kind, in bundle: Bundle = .main) -> LegalDocument? {
        guard let url = bundle.url(forResource: kind.rawValue, withExtension: "md"),
              let markdown = try? String(contentsOf: url, encoding: .utf8)
        else { return nil }
        return LegalDocument(markdown: markdown)
    }
}

private struct Parser {
    var title = ""
    var blocks: [LegalDocument.Block] = []
    private var open: Open?
    private var tableRows: [[String]] = []

    private enum Open {
        case paragraph([String])
        case bullet([String])
        case note([String])
    }

    mutating func read(_ raw: String) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("|") {
            closeText()
            readTableRow(line)
            return
        }
        closeTable()
        if line.isEmpty {
            closeText()
        } else if line.hasPrefix("#") {
            closeText()
            readHeading(line)
        } else if line.hasPrefix(">") {
            readQuote(line)
        } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
            closeText()
            open = .bullet([String(line.dropFirst(2))])
        } else {
            readText(line, indented: raw.hasPrefix("  "))
        }
    }

    private mutating func readTableRow(_ line: String) {
        let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        // The line under the heading row.
        if !cells.allSatisfy({ $0.allSatisfy { $0 == "-" || $0 == ":" } }) {
            tableRows.append(cells)
        }
    }

    /// `#` is the title (then a heading), `##` a heading, `###` a subheading.
    private mutating func readHeading(_ line: String) {
        let level = line.prefix { $0 == "#" }.count
        let text = line.dropFirst(level).trimmingCharacters(in: .whitespaces)
        if level == 1, title.isEmpty {
            title = text
        } else {
            blocks.append(level >= 3 ? .subheading(text) : .heading(text))
        }
    }

    private mutating func readQuote(_ line: String) {
        let text = line.dropFirst().trimmingCharacters(in: .whitespaces)
        if case let .note(lines) = open {
            open = .note(text.isEmpty ? lines + ["\n"] : lines + [text])
        } else {
            closeText()
            open = .note(text.isEmpty ? [] : [text])
        }
    }

    /// A wrapped bullet line (indented), or a paragraph's line.
    private mutating func readText(_ line: String, indented: Bool) {
        switch open {
        case let .bullet(lines) where indented:
            open = .bullet(lines + [line])
        case let .paragraph(lines):
            open = .paragraph(lines + [line])
        default:
            closeText()
            open = .paragraph([line])
        }
    }

    mutating func flush() {
        closeText()
        closeTable()
    }

    private mutating func closeText() {
        switch open {
        case let .paragraph(lines): blocks.append(.paragraph(Self.joined(lines)))
        case let .bullet(lines): blocks.append(.bullet(Self.joined(lines)))
        case let .note(lines): blocks.append(.note(Self.joined(lines)))
        case nil: break
        }
        open = nil
    }

    private mutating func closeTable() {
        guard let header = tableRows.first else { return }
        let rows = tableRows.dropFirst().map { cells in
            zip(header, cells).map { LegalDocument.Cell(label: $0, value: $1) }
        }
        blocks.append(.table(Array(rows)))
        tableRows = []
    }

    /// Wrapped lines as one text; a `"\n"` line (an empty quote line) starts a new paragraph.
    private static func joined(_ lines: [String]) -> String {
        lines.split(separator: "\n").map { $0.joined(separator: " ") }.joined(separator: "\n\n")
    }
}
