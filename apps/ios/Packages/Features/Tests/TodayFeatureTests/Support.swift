import APIClient
import Foundation
import ListoraAPI
@testable import TodayFeature

/// Decodes a contract type from the JSON object the server would send.
func decode<T: Decodable>(_: T.Type, _ object: [String: Any]) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: object))
}

func usd(_ cents: Int) -> [String: Any] {
    ["amountCents": cents, "currency": "USD"]
}

/// A card as the server sends it: `extra` adds the kind's own facts.
func card(
    id: String = "card-1",
    kind: String,
    urgency: String = "normal",
    title: String = "A card",
    detail: String? = nil,
    action: [String: Any] = ["label": "Open item", "destination": "item", "itemId": "item-1"],
    extra: [String: Any] = [:],
) throws -> Components.Schemas.TodayCard {
    var object: [String: Any] = ["id": id, "kind": kind, "urgency": urgency, "title": title, "action": action]
    if let detail {
        object["detail"] = detail
    }
    return try decode(Components.Schemas.TodayCard.self, object.merging(extra) { $1 })
}

func period(sales: Int, itemsSold: Int? = nil, total: Int, profit: Int?, without: Int = 0) -> [String: Any] {
    var object: [String: Any] = [
        "start": "2026-10-18T12:00:00Z",
        "end": "2026-10-25T12:00:00Z",
        "sales": sales,
        "itemsSold": itemsSold ?? sales,
        "salesTotal": usd(total),
        "profitPendingSales": without,
    ]
    if let profit {
        object["profit"] = usd(profit)
    }
    return object
}

func today(cards: [Components.Schemas.TodayCard], thisWeek: [String: Any]? = nil) throws -> Today {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    let encoded = try JSONSerialization.jsonObject(with: encoder.encode(cards))
    let week = thisWeek ?? period(sales: 0, total: 0, profit: 0)
    return try decode(Today.self, [
        "generatedAt": "2026-10-25T12:00:00Z",
        "cards": encoded,
        "money": ["thisWeek": week, "lastWeek": period(sales: 0, total: 0, profit: 0)],
    ])
}

/// A setting a test's model saved.
struct SavedSettings: Equatable {
    let enabled: Bool
    let time: String
    let timeZone: String
}

/// A scripted ``TodayService`` that records what it was asked.
final class FakeTodayService: TodayService, @unchecked Sendable {
    private let lock = NSLock()
    private var todays: [Result<Today, APIFailure>]
    private var settings: Result<SummarySettings, APIFailure>
    private var saves: [Result<SummarySettings, APIFailure>]
    private(set) var saved: [SavedSettings] = []

    init(
        todays: [Result<Today, APIFailure>] = [],
        settings: Result<SummarySettings, APIFailure> = .success(.init(enabled: true, time: "08:00")),
        saves: [Result<SummarySettings, APIFailure>] = [],
    ) {
        self.todays = todays
        self.settings = settings
        self.saves = saves
    }

    func today() async throws(APIFailure) -> Today {
        try lock.withLock { todays.isEmpty ? .failure(.networkUnavailable) : todays.removeFirst() }.get()
    }

    func summarySettings() async throws(APIFailure) -> SummarySettings {
        try lock.withLock { settings }.get()
    }

    func saveSummarySettings(enabled: Bool, time: String, timeZone: String) async throws(APIFailure)
        -> SummarySettings
    {
        try lock.withLock {
            saved.append(SavedSettings(enabled: enabled, time: time, timeZone: timeZone))
            return saves.isEmpty
                ? .success(SummarySettings(enabled: enabled, time: time, timeZone: timeZone))
                : saves.removeFirst()
        }.get()
    }
}
