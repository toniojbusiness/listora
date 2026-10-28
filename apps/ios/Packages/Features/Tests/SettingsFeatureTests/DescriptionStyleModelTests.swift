import APIClient
import Testing
@testable import SettingsFeature

/// The description style: Listora's default until the seller saves their own, saving trimmed
/// text, going back to the default, and a failed save that keeps the seller's typing.
private let defaultStyle = "Write a title line with the size and one emoji."

@MainActor
struct DescriptionStyleModelTests {
    private final class FakeService: DescriptionStyleService, @unchecked Sendable {
        var stored = DescriptionStyle(depop: defaultStyle, depopIsDefault: true)
        var loadFailure: APIFailure?
        var saveFailure: APIFailure?
        private(set) var saves: [String?] = []

        func style() async throws(APIFailure) -> DescriptionStyle {
            if let loadFailure {
                throw loadFailure
            }
            return stored
        }

        func save(depop: String?) async throws(APIFailure) -> DescriptionStyle {
            saves.append(depop)
            if let saveFailure {
                throw saveFailure
            }
            stored = depop.map { DescriptionStyle(depop: $0, depopIsDefault: false) }
                ?? DescriptionStyle(depop: defaultStyle, depopIsDefault: true)
            return stored
        }
    }

    @Test
    func `starts the editor from Listora's default, with nothing to save`() async {
        let service = FakeService()
        let model = DescriptionStyleModel(service: service)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.style?.depopIsDefault == true)
        #expect(model.draft == defaultStyle)
        #expect(!model.hasChanges)
        #expect(!model.canSave)
    }

    @Test
    func `saves the seller's own style trimmed`() async {
        let service = FakeService()
        let model = DescriptionStyleModel(service: service)
        await model.load()
        model.draft = "  Plain and short, no emoji.\n"
        #expect(model.canSave)
        #expect(model.length == "Plain and short, no emoji.".count)
        #expect(await model.save())
        #expect(service.saves == ["Plain and short, no emoji."])
        #expect(model.style == DescriptionStyle(depop: "Plain and short, no emoji.", depopIsDefault: false))
        #expect(!model.hasChanges)
    }

    @Test
    func `refuses to save a blank or too long style`() async {
        let model = DescriptionStyleModel(service: FakeService())
        await model.load()
        model.draft = "   "
        #expect(!model.canSave)
        model.draft = String(repeating: "x", count: DescriptionStyleModel.maxLength + 1)
        #expect(!model.canSave)
        // An emoji such as ❤️ is two characters to the server.
        model.draft = "❤️"
        #expect(model.length == 2)
        #expect(await model.save())
    }

    @Test
    func `goes back to Listora's default`() async {
        let service = FakeService()
        service.stored = DescriptionStyle(depop: "My own style.", depopIsDefault: false)
        let model = DescriptionStyleModel(service: service)
        await model.load()
        #expect(await model.useDefault())
        #expect(service.saves == [nil])
        #expect(model.style?.depopIsDefault == true)
        #expect(model.draft == defaultStyle)
    }

    @Test
    func `keeps the typing and says why when a save fails`() async {
        let service = FakeService()
        let model = DescriptionStyleModel(service: service)
        await model.load()
        service.saveFailure = APIFailure(
            statusCode: 403,
            code: "forbidden",
            message: "Only the account's owner can change the description style.",
            retryable: false,
        )
        model.draft = "Short and sweet."
        #expect(await !(model.save()))
        #expect(model.saveError == "Only the account's owner can change the description style.")
        #expect(model.draft == "Short and sweet.")
        #expect(model.style?.depopIsDefault == true)
    }

    @Test
    func `shows why the style could not load, and loads on a retry`() async {
        let service = FakeService()
        service.loadFailure = APIFailure(
            statusCode: 500,
            code: "internal_error",
            message: "Try again.",
            retryable: true,
        )
        let model = DescriptionStyleModel(service: service)
        await model.load()
        #expect(model.phase == .failed(message: "Try again."))
        service.loadFailure = nil
        await model.load()
        #expect(model.phase == .loaded)
    }
}
