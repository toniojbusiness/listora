import APIClient
import Foundation
import ListoraAPI
import Observation
import SwiftUI

typealias SalePackOrder = Components.Schemas.PackOrder

/// Pack check on a sale's own screen (docs/features/pack-check.md, "On the sale's screen"),
/// handed over by `AppDependencies` (another feature's screen): while Pack check is on, an order
/// that still needs shipping is packed from its screen, and a packed one says when and how.
@MainActor
public struct SalePackEntry {
    let isOn: @MainActor () -> Bool
    /// The sale's order as Pack check sees it (`getPackOrder`); `nil` when Pack check has none.
    let order: @MainActor (String) async throws(APIFailure) -> Components.Schemas.PackOrder?
    /// The packing flow for this one order; `onClose` runs when the seller closes it.
    let packScreen: @MainActor (Components.Schemas.PackOrder, @escaping @MainActor () -> Void) -> AnyView

    public init(
        isOn: @escaping @MainActor () -> Bool,
        order: @escaping @MainActor (String) async throws(APIFailure) -> Components.Schemas.PackOrder?,
        packScreen: @escaping @MainActor (Components.Schemas.PackOrder, @escaping @MainActor () -> Void) -> AnyView,
    ) {
        self.isOn = isOn
        self.order = order
        self.packScreen = packScreen
    }
}

/// One sale's package: loaded with the sale, and again after packing.
@MainActor
@Observable
final class SalePackModel {
    enum State: Equatable {
        case loading
        /// Pack check has no package for this sale.
        case none
        case failed(message: String)
        case loaded(SalePackOrder)
    }

    private(set) var state: State = .loading
    private let saleID: String
    private let fetch: @MainActor (String) async throws(APIFailure) -> SalePackOrder?

    init(saleID: String, fetch: @escaping @MainActor (String) async throws(APIFailure) -> SalePackOrder?) {
        self.saleID = saleID
        self.fetch = fetch
    }

    /// The order to pack, once loaded and not packed yet.
    var orderToPack: SalePackOrder? {
        if case let .loaded(order) = state, order.pack == nil {
            return order
        }
        return nil
    }

    /// The packed order, to show when and how it was packed.
    var packedOrder: SalePackOrder? {
        if case let .loaded(order) = state, order.pack != nil {
            return order
        }
        return nil
    }

    func load() async {
        do {
            state = try await fetch(saleID).map(State.loaded) ?? .none
        } catch {
            // A refresh that fails keeps what is shown.
            if case .loaded = state {
                return
            }
            state = .failed(message: error.message)
        }
    }
}

/// One step on a sale's screen: Pack check's packing, or one of the sale's own actions.
enum SaleStep: Hashable {
    case pack
    case sale(Components.Schemas.KnownSaleAction)
}

/// Which step is the sale screen's main one, and the others below it.
struct SaleSteps: Equatable {
    let primary: SaleStep?
    let others: [SaleStep]

    /// With Pack check on (`package` given) and the order still to ship, packing comes first and
    /// Mark shipped is one of the others; packed, or with Pack check off, shipping (or recording
    /// a return) is the main step, as before. A package that is still loading, or that couldn't
    /// load, is still to pack: the flow says what went wrong and retries.
    init(actions: [Components.Schemas.KnownSaleAction], package: SalePackModel.State?) {
        let toPack: Bool = switch package {
        case nil, .none?: false
        case let .loaded(order)?: order.pack == nil
        case .loading?, .failed?: true
        }
        if toPack, actions.contains(.markShipped) {
            primary = .pack
            others = actions.map(SaleStep.sale)
        } else {
            let main = actions.first { $0 == .markShipped || $0 == .recordReturn }
            primary = main.map(SaleStep.sale)
            others = actions.filter { $0 != main }.map(SaleStep.sale)
        }
    }
}
