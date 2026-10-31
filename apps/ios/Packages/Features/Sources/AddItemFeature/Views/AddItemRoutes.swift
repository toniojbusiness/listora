import Core
import Foundation

/// A screen of the Add Item tab's navigation stack.
enum AddItemRoute: Hashable {
    case draft(String)
    /// The review of a draft's server item (the review feature's flow).
    case review(ItemReviewRequest)
    /// A batch: its items and their progress.
    case batch(String)
    /// Checking how a batch's new photos are grouped into items.
    case batchGrouping(String)
    /// The rapid review of a batch's analyzed items (the review feature's), by the batch's id on
    /// this iPhone.
    case batchReview(String, BatchReviewRequest)
}

/// Whether Add Item starts one item, a whole haul, or scans items at the store.
enum AddItemMode: String, CaseIterable {
    case single
    case batch
    /// The thrift scan (docs/features/thrift-scan.md), shown only where it is on.
    case scan

    /// Where the seller's last choice is kept (`UserDefaults`).
    static let storageKey = "com.listora.add-item-mode"

    var title: String {
        switch self {
        case .single: "One item"
        case .batch: "Batch"
        case .scan: "Scan"
        }
    }

    /// The modes the picker offers.
    static func offered(scan: Bool) -> [AddItemMode] {
        scan ? allCases : [.single, .batch]
    }
}

/// The camera that is open: the guided capture of one item, or a batch's. One presentation for
/// both, because two full-screen covers on one view do not reliably dismiss.
enum OpenCamera: Identifiable {
    case single
    case batch(String)
    case scan(ScanRunModel)

    var id: String {
        switch self {
        case .single: "single"
        case let .batch(batchID): "batch-\(batchID)"
        case let .scan(run): "scan-\(run.id)"
        }
    }
}
