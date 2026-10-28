import Foundation

/// Syncs the linked marketplaces now (docs/features/sync.md): read-only checks of their sales,
/// offers, and listings, which the phone runs at once for the marketplaces that run on it. The
/// screens with a Sync now button or a pull to refresh (Today, Sales) and Link accounts' "Last
/// synced" read it; `SyncFeature`'s model is the app's one.
@MainActor
public protocol MarketplaceSync: AnyObject {
    /// Whether a sync is being asked for or a marketplace is being read now.
    var isSyncing: Bool { get }
    /// Asks Listora to sync every linked marketplace now and the phone to run its share at once;
    /// returns once Listora took the request (the indicator follows the reads after).
    func syncNow() async
    /// Reads each marketplace's sync again (when it last got through), without syncing.
    func refreshStatus() async
    /// When a read of the marketplace (`depop`) last got through; `nil` before the first.
    func lastSyncedAt(_ marketplace: String) -> Date?
}
