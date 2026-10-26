import Foundation

/// The Today screen's answers: a card of every kind, or nothing to do.
extension StubAPIServer {
    static let shipCardID = "ship:7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a"
    static let reconnectCardID = "reconnect:6c5b4a39-2817-4f6e-9d5c-4b3a29180716"
    static let draftsCardID = "review_drafts"
    static let staleItemId = "5b4a3928-1706-4e5d-8c4b-3a2918070605"
    static let staleCardID = "stale:\(staleItemId)"

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
        let stale = #"{"id":"\#(staleCardID)","kind":"stale_listing","urgency":"normal","title":"Patagonia Better "#
            + #"Sweater fleece","detail":"Listed 45 days with no changes. Try $40, still above your $35 floor.","#
            + #""action":{"label":"Lower to $40","destination":"item","itemId":"\#(staleItemId)"},"#
            + #""item":{"id":"\#(staleItemId)","sku":"AJ-000185","title":"Patagonia Better Sweater fleece"},"#
            + #""staleListing":{"listedAt":"\#(at(-45 * 24))","daysListed":45,"price":\#(usd(4500)),"#
            + #""floor":\#(usd(3500)),"suggestion":"price_drop","suggestedPrice":\#(usd(4000)),"#
            + #""marketplaces":["ebay","poshmark"]}}"#
        let money = #"{"thisWeek":{"start":"\#(at(-168))","end":"\#(at(0))","sales":3,"itemsSold":3,"#
            + #""salesTotal":\#(usd(14200)),"profit":\#(usd(6150)),"profitPendingSales":1},"#
            + #""lastWeek":{"start":"\#(at(-336))","end":"\#(at(-168))","sales":2,"itemsSold":2,"#
            + #""salesTotal":\#(usd(9800)),"profit":\#(usd(4100)),"profitPendingSales":0}}"#
        return #"{"generatedAt":"\#(at(0))","cards":[\#([ship, reconnect, drafts, stale].joined(separator: ","))],"#
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
