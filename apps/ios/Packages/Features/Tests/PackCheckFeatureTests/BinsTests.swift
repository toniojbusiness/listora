import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import PackCheckFeature

/// A fake server with invented bins: B-3 (one item) and B-12 (empty), the next code B-13. Bins'
/// codes are kept in capitals and never twice, as the server's rules say.
actor FakeBins: BinsService {
    struct Spec: Equatable {
        var id: String
        var code: String
        var label: String?
        var items: Int
    }

    private(set) var specs = [
        Spec(id: "bin-3", code: "B-3", items: 1),
        Spec(id: "bin-12", code: "B-12", label: "Garage shelf 3", items: 0),
    ]
    struct PutCall: Equatable {
        let itemIDs: [String]
        let bin: String
        let key: String
    }

    private(set) var putCalls: [PutCall] = []
    private(set) var takeOutCalls: [(item: String, bin: String)] = []
    private(set) var createKeys: [String] = []
    private var failsNextPut = false
    private var failsNextList = false

    func failNextPut() {
        failsNextPut = true
    }

    func failNextList() {
        failsNextList = true
    }

    func bins() async throws(APIFailure) -> BinList {
        if failsNextList {
            failsNextList = false
            throw .networkUnavailable
        }
        return try BinList(bins: specs.map(Self.bin), nextCode: "B-\(specs.count + 11)")
    }

    func bin(id: String) async throws(APIFailure) -> BinDetail {
        guard let spec = specs.first(where: { $0.id == id }) else { throw notFound }
        return try Self.read(BinDetail.self, [
            "location": Self.object(spec),
            "items": spec.items > 0 ? [["itemId": "item-1", "sku": "AJ-000184", "status": "listed"]] : [],
        ])
    }

    func create(code: String, label: String?, idempotencyKey: String) async throws(APIFailure) -> Bin {
        createKeys.append(idempotencyKey)
        let normalized = BinCode.normalized(code)
        if specs.contains(where: { $0.code == normalized }) {
            throw APIFailure(
                statusCode: 409,
                code: "already_exists",
                message: "You already have a bin \(normalized). Pick another code.",
                retryable: false,
            )
        }
        let spec = Spec(id: "bin-new-\(specs.count)", code: normalized, label: label, items: 0)
        specs.append(spec)
        return try Self.bin(spec)
    }

    func rename(id: String, code: String, label: String?) async throws(APIFailure) -> Bin {
        guard let index = specs.firstIndex(where: { $0.id == id }) else { throw notFound }
        specs[index].code = BinCode.normalized(code)
        specs[index].label = label
        return try Self.bin(specs[index])
    }

    func delete(id: String) async throws(APIFailure) {
        specs.removeAll { $0.id == id }
    }

    func put(itemIDs: [String], inBin id: String, idempotencyKey: String) async throws(APIFailure) -> BinDetail {
        putCalls.append(PutCall(itemIDs: itemIDs, bin: id, key: idempotencyKey))
        if failsNextPut {
            failsNextPut = false
            throw .networkUnavailable
        }
        return try await bin(id: id)
    }

    func takeOut(itemID: String, ofBin id: String) async throws(APIFailure) -> BinDetail {
        takeOutCalls.append((itemID, id))
        return try await bin(id: id)
    }

    private var notFound: APIFailure {
        APIFailure(statusCode: 404, code: "not_found", message: "Bin was not found.", retryable: false)
    }

    private static func object(_ spec: Spec) -> [String: Any] {
        var object: [String: Any] = [
            "id": spec.id, "code": spec.code, "itemCount": spec.items,
            "createdAt": "2026-10-30T12:00:00Z", "updatedAt": "2026-10-30T12:00:00Z",
        ]
        if let label = spec.label {
            object["label"] = label
        }
        return object
    }

    private static func bin(_ spec: Spec) throws(APIFailure) -> Bin {
        try read(Bin.self, object(spec))
    }

    private static func read<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws(APIFailure) -> T {
        do {
            return try decode(type, object)
        } catch {
            throw .networkUnavailable
        }
    }
}

/// What the picker answered with: the bin, or nil for taken out.
@MainActor
final class PickedBins {
    var answers: [BinChoice?] = []
}

@MainActor
struct BinsTests {
    let service: FakeBins
    let picked = PickedBins()

    init() {
        service = FakeBins()
    }

    private func picker(_ request: BinRequest = BinRequest(itemIDs: ["item-1"])) -> BinPickerModel {
        BinPickerModel(request: request, service: service) { [picked] in picked.answers.append($0) }
    }

    @Test
    func `scanning a bin's sticker puts the item in that bin`() async {
        let model = picker()
        await model.load()
        await model.scanned("LISTORA-BIN:b-12")
        #expect(picked.answers == [BinChoice(id: "bin-12", code: "B-12")])
        #expect(await service.putCalls.map(\.bin) == ["bin-12"])
        #expect(await service.putCalls.first?.itemIDs == ["item-1"])
    }

    @Test
    func `an item's sticker is not a bin, and nothing moves`() async {
        let model = picker()
        await model.load()
        await model.scanned("LISTORA:AJ-000184")
        #expect(model.failure == "That isn't a bin sticker. Scan the QR code on the bin.")
        #expect(picked.answers.isEmpty)
        #expect(await service.putCalls.isEmpty)
    }

    @Test
    func `a scanned code no bin has is offered as a new bin, which the item then goes in`() async {
        let model = picker()
        await model.load()
        await model.scanned("LISTORA-BIN:B-40")
        #expect(model.unknownCode == "B-40")
        #expect(picked.answers.isEmpty)
        let form = model.makeForm()
        #expect(form.code == "B-40")
        #expect(await form.save())
        // The form's save hands the new bin to the picker, which puts the item in it.
        for _ in 0 ..< 100 where picked.answers.isEmpty {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(picked.answers.first??.code == "B-40")
    }

    @Test
    func `a failed put says why, shows no bin, and its retry sends the same request`() async {
        let model = picker()
        await model.load()
        await service.failNextPut()
        let shelf = model.bins[1]
        await model.put(in: shelf)
        #expect(model.failure == APIFailure.networkUnavailable.message)
        #expect(picked.answers.isEmpty)
        await model.put(in: shelf)
        #expect(picked.answers == [BinChoice(id: "bin-12", code: "B-12")])
        let keys = await service.putCalls.map(\.key)
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test
    func `the bin an item is in already answers at once, and taking it out answers nil`() async {
        let current = BinChoice(id: "bin-3", code: "B-3")
        let model = picker(BinRequest(itemIDs: ["item-1"], current: current))
        await model.load()
        await model.put(in: model.bins[0])
        #expect(picked.answers == [current])
        #expect(await service.putCalls.isEmpty)
        await model.takeOut()
        #expect(picked.answers == [current, nil])
        #expect(await service.takeOutCalls.map(\.bin) == ["bin-3"])
    }

    @Test
    func `a run's kept items go in one bin together`() async {
        let model = picker(BinRequest(itemIDs: ["item-1", "item-2", "item-3"]))
        #expect(model.title == "Put 3 items in a bin")
        await model.load()
        await model.put(in: model.bins[0])
        #expect(await service.putCalls.first?.itemIDs == ["item-1", "item-2", "item-3"])
    }

    @Test
    func `new bin offers the next code, and a taken code says so without closing`() async {
        let list = BinsModel(service: service)
        await list.load()
        #expect(list.bins.map(\.code) == ["B-3", "B-12"])
        let form = list.makeForm()
        #expect(form.code == "B-13")
        form.code = "b-12"
        #expect(await form.save() == false)
        #expect(form.failure == "You already have a bin B-12. Pick another code.")
        form.code = "B-13"
        form.label = "  "
        #expect(await form.save())
        // Both tries were the same bin.
        let keys = await service.createKeys
        #expect(keys.count == 2 && keys[0] == keys[1])
    }

    @Test
    func `a bin that fails to load can be tried again, and deleting it leaves the screen`() async {
        await service.failNextList()
        let list = BinsModel(service: service)
        await list.load()
        #expect(list.phase == .failed(APIFailure.networkUnavailable.message))
        await list.load()
        #expect(list.phase == .loaded)

        let detail = BinDetailModel(binID: "bin-3", service: service)
        await detail.load()
        #expect(detail.detail?.items.map(\.sku) == ["AJ-000184"])
        await detail.delete()
        #expect(detail.phase == .gone)
        #expect(await service.specs.map(\.code) == ["B-12"])
    }

    @Test
    func `a bin's sticker holds its code apart from an item's`() {
        let sticker = StickerRequest(binCode: "b-12", label: "Garage shelf 3")
        #expect(sticker.code == "LISTORA-BIN:B-12")
        #expect(sticker.id == "bin:B-12")
        #expect(StickerRequest(sku: "AJ-000184", title: nil, locationCode: "B-12").code == "LISTORA:AJ-000184")
        let pdf = StickerSheet.pdf([sticker], format: .roll225x125)
        #expect(!pdf.isEmpty)
    }
}
