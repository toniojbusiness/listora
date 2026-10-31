import Foundation

/// The thrift scan's comparison lane (docs/features/thrift-scan.md, "Marketplace comparisons"):
/// reads of a marketplace's public search for a scanned item, made on this iPhone in a web view
/// that holds no account and never signs in. The server hands out each read (`ScanComparison.read`)
/// and takes the answer; the lane only runs it. Add Item asks for it; the phone execution feature
/// implements it, so the two never import each other.
@MainActor
public protocol MarketComparisons: AnyObject {
    /// Opens each marketplace's search page in its own logged-out web view, so the first read of
    /// a run starts warm (while the seller walks to the bins).
    func warmUp(_ marketplaces: [String])
    /// Runs one read (`ScanComparison.read.input`, as JSON) and returns the runtime's answer
    /// (`ScanComparisonAnswer`, as JSON). A marketplace this iPhone saw a check on today is not
    /// read again: the answer is that check. Nil when the app can't read at all.
    func compare(_ input: Data, marketplace: String) async -> Data?
    /// Lets the web views go (the run ended).
    func coolDown()
}
