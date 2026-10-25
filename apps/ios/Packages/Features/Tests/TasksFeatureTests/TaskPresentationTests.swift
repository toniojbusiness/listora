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
}
