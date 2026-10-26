import Foundation
import Testing
@testable import SettingsFeature

/// The privacy policy and terms read from docs/legal's Markdown.
struct LegalDocumentTests {
    @Test
    func `reads headings, paragraphs, wrapped bullets, quotes, and tables`() {
        let document = LegalDocument(markdown: """
        # Listora privacy policy (draft)

        > **DRAFT - not reviewed.** Must be
        > reviewed.
        >
        > Second paragraph.

        Effective date: [effective date]

        ## Summary

        - Listora uses your data only
          to run the app.
        - It does not sell it.

        | Data    | What it is       | Why        |
        | ------- | ---------------- | ---------- |
        | Account | Your email.      | Sign in.   |
        | Photos  | What you take.   | Listings.  |

        ### Deleting your account

        Open Settings
        and tap Delete account.
        """)
        #expect(document.title == "Listora privacy policy (draft)")
        #expect(document.blocks == [
            .note("**DRAFT - not reviewed.** Must be reviewed.\n\nSecond paragraph."),
            .paragraph("Effective date: [effective date]"),
            .heading("Summary"),
            .bullet("Listora uses your data only to run the app."),
            .bullet("It does not sell it."),
            .table([
                [
                    .init(label: "Data", value: "Account"),
                    .init(label: "What it is", value: "Your email."),
                    .init(label: "Why", value: "Sign in."),
                ],
                [
                    .init(label: "Data", value: "Photos"),
                    .init(label: "What it is", value: "What you take."),
                    .init(label: "Why", value: "Listings."),
                ],
            ]),
            .subheading("Deleting your account"),
            .paragraph("Open Settings and tap Delete account."),
        ])
    }

    @Test(arguments: LegalDocument.Kind.allCases)
    func `reads the repository's own drafts`(kind: LegalDocument.Kind) throws {
        // This file is apps/ios/Packages/Features/Tests/SettingsFeatureTests/LegalDocumentTests.swift.
        let root = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../../../")
        let url = root.appending(path: "docs/legal/\(kind.rawValue).md").standardized
        let document = try LegalDocument(markdown: String(contentsOf: url, encoding: .utf8))
        #expect(!document.title.isEmpty)
        #expect(document.blocks.count > 10)
        #expect(document.blocks.contains {
            if case .heading = $0 {
                true
            } else {
                false
            }
        })
        // Every table row has a cell for every column heading.
        for case let .table(rows) in document.blocks {
            #expect(rows.allSatisfy { $0.count == rows.first?.count })
        }
    }
}
