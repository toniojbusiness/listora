import Foundation
import Testing
@testable import TasksFeature

struct TaskPresentationTests {
    @Test
    func `a list task saves photos copies details opens the marketplace and takes the link`() {
        let presentation = TaskPresentation(Fixtures.task())
        #expect(presentation.kind == .list)
        #expect(presentation.marketplaceName == "Poshmark")
        #expect(presentation.steps(hasPhotos: true, hasFields: true, hasLink: true) == [
            .savePhotos, .copyDetails, .open(title: "Post it on Poshmark"), .pasteLink,
        ])
        #expect(presentation.openTitle == "Open Poshmark")
        #expect(presentation.doneTitle == "Done - I posted it")
    }

    @Test
    func `a delist task opens the exact listing and is confirmed as the users step`() {
        let presentation = TaskPresentation(Fixtures.task(
            kind: "delist_manually",
            urgency: "urgent",
            fields: [],
            photos: [],
        ))
        #expect(presentation.isUrgent)
        #expect(presentation.steps(hasPhotos: false, hasFields: false, hasLink: true) == [
            .open(title: "Open the listing"), .removeListing,
        ])
        #expect(presentation.openTitle == "Open the listing on Poshmark")
        #expect(presentation.doneTitle == "Done - I removed it")
    }

    @Test
    func `an edit task copies the change and opens the listing`() {
        let presentation = TaskPresentation(Fixtures.task(kind: "edit_manually", marketplace: "mercari", photos: []))
        #expect(presentation.steps(hasPhotos: false, hasFields: true, hasLink: true) == [
            .copyDetails, .open(title: "Change it on Mercari"),
        ])
        #expect(presentation.doneTitle == "Done - I saved the change")
    }

    @Test
    func `no task wording ever claims A marketplace confirmed it`() {
        for kind in [
            "list_manually",
            "edit_manually",
            "delist_manually",
            "reconnect",
            "confirm_sale",
            "review_match",
            "later_kind",
        ] {
            let presentation = TaskPresentation(Fixtures.task(kind: kind))
            let words = [presentation.doneTitle ?? "", presentation.openTitle].joined(separator: " ")
            #expect(!words.localizedCaseInsensitiveContains("confirmed by"), "\(kind)")
        }
    }

    @Test
    func `a kind this build does not know offers only its link`() {
        let presentation = TaskPresentation(Fixtures.task(kind: "later_kind"))
        #expect(presentation.kind == .unknown)
        #expect(presentation.doneTitle == nil)
        #expect(presentation.steps(hasPhotos: true, hasFields: true, hasLink: true) == [.open(title: "Open Poshmark")])
    }

    @Test
    func `a sale email confirm task shows the email and confirms that it sold`() {
        let task = Fixtures.task(
            kind: "confirm_sale",
            urgency: "urgent",
            deepLink: nil,
            operationID: nil,
            fields: [],
            photos: [],
            saleEmail: Fixtures.saleEmail(reason: "ask_before_delist"),
        )
        let presentation = TaskPresentation(task)
        #expect(presentation.isSaleEmail)
        #expect(presentation.steps(hasPhotos: false, hasFields: false, hasLink: false) == [.saleEmail])
        #expect(presentation.doneTitle == "Confirm - it sold")
        #expect(presentation.rejectTitle == nil)
        #expect(presentation.dismissMessage == "Listora won't record the sale or delist the item anywhere.")
    }

    @Test
    func `a sale email review offers its candidates and none of these`() {
        let candidates = [
            (id: "0199f0b4-0000-7000-8000-0000000000c1", sku: "AJ-000001"),
            (id: "0199f0b4-0000-7000-8000-0000000000c2", sku: "AJ-000002"),
        ]
        let presentation = TaskPresentation(Fixtures.task(
            kind: "review_match",
            deepLink: nil,
            operationID: nil,
            fields: [],
            photos: [],
            saleEmail: Fixtures.saleEmail(reason: "ambiguous_match", candidates: candidates),
        ))
        #expect(presentation.steps(hasPhotos: false, hasFields: false, hasLink: false) == [.saleEmail, .pickItem])
        #expect(presentation.doneTitle == nil)
        #expect(presentation.rejectTitle == "None of these sold")

        let unreadable = TaskPresentation(Fixtures.task(
            kind: "review_match",
            operationID: nil,
            fields: [],
            photos: [],
            saleEmail: Fixtures.saleEmail(reason: "unknown_format"),
        ))
        #expect(unreadable.steps(hasPhotos: false, hasFields: false, hasLink: true) == [.saleEmail])
        #expect(unreadable.rejectTitle == "Done - nothing to record")
    }

    @Test
    func `a confirm or review task without a sale email still cannot be finished here`() {
        for kind in ["confirm_sale", "review_match"] {
            let presentation = TaskPresentation(Fixtures.task(kind: kind))
            #expect(!presentation.isSaleEmail)
            #expect(presentation.doneTitle == nil)
            #expect(presentation.rejectTitle == nil)
        }
    }
}
