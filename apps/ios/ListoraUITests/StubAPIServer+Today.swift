import Foundation

/// The Today screen's answers: a card of every kind, or nothing to do.
extension StubAPIServer {
    static let shipCardID = "ship:7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a"
    static let reconnectCardID = "reconnect:6c5b4a39-2817-4f6e-9d5c-4b3a29180716"
    static let draftsCardID = "review_drafts"

    /// A card of every kind and this week's sales, dated around now, in the server's words
    /// (`packages/today/src/cards.ts`).
    static func busyToday() -> String {
        func at(_ hours: Double) -> String {
            Date(timeIntervalSinceNow: hours * 3600).ISO8601Format()
        }
        let usd = { (cents: Int) in #"{"amountCents":\#(cents),"currency":"USD"}"# }
        let ship = #"{"id":"\#(shipCardID)","kind":"ship","urgency":"urgent","title":"Ship Lululemon Align pant","#
            + #""detail":"Sold on eBay","action":{"label":"Open sale","destination":"sale","itemId":"\#(itemId)","#
            + #""saleId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"},"#
            + #""item":{"id":"\#(itemId)","sku":"AJ-000184","title":"Lululemon Align pant"},"#
            + #""shipment":{"saleId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","marketplace":"ebay","#
            + #""soldAt":"\#(at(-3))","shipBy":"\#(at(20))","location":{"code":"B-12","label":"Garage shelf 3"}}}"#
        let reconnect = #"{"id":"\#(reconnectCardID)","kind":"reconnect","urgency":"high","title":"Reconnect eBay","#
            + #""detail":"eBay stopped accepting Listora's access. Reconnect so Listora can keep your listings "#
            + #"there in sync.","action":{"label":"Reconnect","destination":"marketplaces","#
            + #""connectionId":"6c5b4a39-2817-4f6e-9d5c-4b3a29180716"},"connection":{"#
            + #""connectionId":"6c5b4a39-2817-4f6e-9d5c-4b3a29180716","marketplace":"ebay","#
            + #""displayName":"listora_seller","status":"reauth_required"}}"#
        let drafts = #"{"id":"\#(draftsCardID)","kind":"review_drafts","urgency":"normal","#
            + #""title":"2 drafts to review","#
            + #""detail":"Check their details and prices, and they're ready to list everywhere.","#
            + #""action":{"label":"Review drafts","destination":"drafts"},"#
            + #""drafts":{"count":2,"oldestCreatedAt":"\#(at(-50))"}}"#
        let money = #"{"thisWeek":{"start":"\#(at(-168))","end":"\#(at(0))","sales":3,"itemsSold":3,"#
            + #""salesTotal":\#(usd(14200)),"profit":\#(usd(6150)),"profitPendingSales":1},"#
            + #""lastWeek":{"start":"\#(at(-336))","end":"\#(at(-168))","sales":2,"itemsSold":2,"#
            + #""salesTotal":\#(usd(9800)),"profit":\#(usd(4100)),"profitPendingSales":0}}"#
        return #"{"generatedAt":"\#(at(0))","cards":[\#([ship, reconnect, drafts].joined(separator: ","))],"#
            + #""money":\#(money)}"#
    }

    static func caughtUpToday() -> String {
        let now = Date().ISO8601Format()
        let week = Date(timeIntervalSinceNow: -7 * 86400).ISO8601Format()
        let zero = #"{"start":"\#(week)","end":"\#(now)","sales":0,"itemsSold":0,"#
            + #""salesTotal":{"amountCents":0,"currency":"USD"},"profit":{"amountCents":0,"currency":"USD"},"#
            + #""profitPendingSales":0}"#
        return #"{"generatedAt":"\#(now)","cards":[],"money":{"thisWeek":\#(zero),"lastWeek":\#(zero)}}"#
    }
}
