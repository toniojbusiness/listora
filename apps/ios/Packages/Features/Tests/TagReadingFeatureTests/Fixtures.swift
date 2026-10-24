import Foundation
import Testing

/// The synthetic tag photos in `Fixtures/` and what each one shows, from `Fixtures/manifest.json`.
/// `apps/ios/Tools/generate-tag-fixtures.swift` renders both (`make ios-tag-fixtures`).
struct Fixture: CustomTestStringConvertible {
    struct Barcode: Decodable, Equatable {
        let symbology: String
        let payload: String
    }

    let name: String
    let file: String
    let purpose: String
    /// Lines the reader must return, exactly.
    let lines: [String]
    let barcodes: [Barcode]
    /// Short size-tab labels the reader must return.
    let sizeTabs: [String]

    var testDescription: String {
        name
    }

    func data() throws -> Data {
        guard let url = Bundle.module.url(forResource: file, withExtension: nil, subdirectory: "Fixtures") else {
            throw FixtureError.missing(file)
        }
        return try Data(contentsOf: url)
    }

    static let all: [Fixture] = {
        guard
            let url = Bundle.module.url(forResource: "manifest", withExtension: "json", subdirectory: "Fixtures"),
            let data = try? Data(contentsOf: url),
            let entries = try? JSONDecoder().decode([String: Entry].self, from: data)
        else { return [] }
        return entries.keys.sorted().compactMap { name in
            entries[name].map { entry in
                Fixture(
                    name: name, file: entry.file, purpose: entry.purpose, lines: entry.lines,
                    barcodes: entry.barcodes, sizeTabs: entry.sizeTabs,
                )
            }
        }
    }()

    static func named(_ name: String) throws -> Fixture {
        guard let fixture = all.first(where: { $0.name == name }) else { throw FixtureError.missing(name) }
        return fixture
    }

    private struct Entry: Decodable {
        let file: String
        let purpose: String
        let lines: [String]
        let barcodes: [Barcode]
        let sizeTabs: [String]
    }
}

enum FixtureError: Error {
    case missing(String)
}
