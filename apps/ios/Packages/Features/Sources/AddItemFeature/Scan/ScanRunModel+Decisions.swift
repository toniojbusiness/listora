import DesignSystem
import Foundation

/// The seller's two answers to a card (docs/features/thrift-scan.md, "On the iPhone"): Keep and
/// Put back. Either one closes the card at once, so the live camera is clear for the next shot,
/// and a brief line over the camera says what happened and how many items this run kept.
/// Shooting the next item without choosing is the same as Put back.
extension ScanRunModel {
    /// Keep from the card: the card closes at once and the item is saved as a draft in the
    /// background; the line over the camera says "Kept" only once the draft is saved.
    func keepAndContinue(_ entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.canKeep else { return }
        decided(entryID)
        confirmation = ScanConfirmation(entryID: entryID, kind: .kept)
        await keep(entryID)
    }

    /// Put back from the card: the card closes and the camera is clear for the next item. The
    /// item counts as passed on, like shooting the next one, so the tray can still keep it until
    /// the run ends.
    func putBack(_ entryID: String) {
        guard entries.contains(where: { $0.id == entryID }) else { return }
        decided(entryID)
        confirmation = ScanConfirmation(entryID: entryID, kind: .putBack)
        Haptics.play(.tap)
    }

    /// Closes a card opened from the tray that has nothing left to decide (it was kept).
    func closeCard(_ entryID: String) {
        guard currentID == entryID else { return }
        tagShotFor = nil
        currentID = nil
    }

    /// Hides the line over the camera, unless a newer one replaced it.
    func clearConfirmation(_ id: UUID) {
        if confirmation?.id == id {
            confirmation = nil
        }
    }

    /// The card left the screen: the camera is clear for the next shot. Records how long that
    /// took after Keep or Put back, for the owner's measurements.
    func cardClosed(_ entryID: String) {
        guard let decided = decidedAt, decided.entryID == entryID else { return }
        decidedAt = nil
        let after = now().timeIntervalSince(decided.at)
        readyTimes.append(after)
        log.info("scan camera ready \(Int(after * 1000), privacy: .public) ms after the decision")
    }

    /// What the line over the camera says, from the entry as it is now: "Keeping item 3" while
    /// the draft is saved, then "Kept · 3 in this run".
    var confirmationLine: ScanConfirmationLine? {
        guard let confirmation, let entry = entries.first(where: { $0.id == confirmation.entryID }) else {
            return nil
        }
        return confirmation.line(for: entry, keptCount: keptCount)
    }

    private func decided(_ entryID: String) {
        if currentID == entryID {
            tagShotFor = nil
            currentID = nil
            decidedAt = (entryID, now())
        }
    }
}

/// The brief line over the camera after a decision.
struct ScanConfirmation: Equatable, Identifiable {
    enum Kind: Equatable {
        case kept
        case putBack
    }

    let id = UUID()
    let entryID: String
    let kind: Kind

    /// How long a settled line stays; a failure stays longer, so it is read.
    static let shownFor: Duration = .milliseconds(1600)
    static let failureShownFor: Duration = .seconds(5)

    func line(for entry: ScanEntry, keptCount: Int) -> ScanConfirmationLine {
        let kept = switch keptCount {
        case 0: "none kept yet"
        case 1: "1 kept this run"
        default: "\(keptCount) kept this run"
        }
        switch kind {
        case .putBack:
            return ScanConfirmationLine(text: "Put back · \(kept)", tone: .done, systemImage: "arrow.uturn.backward")
        case .kept:
            switch entry.decision {
            case .open, .keeping:
                return ScanConfirmationLine(
                    text: "Keeping item \(entry.number)",
                    tone: .working,
                    systemImage: "arrow.down.circle",
                )
            case .kept:
                let count = keptCount == 1 ? "1 in this run" : "\(keptCount) in this run"
                return ScanConfirmationLine(text: "Kept · \(count)", tone: .done, systemImage: "checkmark.circle.fill")
            case .keepFailed:
                return ScanConfirmationLine(
                    text: "Couldn't keep item \(entry.number). Tap it below to try again.",
                    tone: .failed,
                    systemImage: "exclamationmark.triangle.fill",
                )
            }
        }
    }
}

/// What the line over the camera says.
struct ScanConfirmationLine: Equatable {
    enum Tone: Equatable {
        case working
        case done
        case failed
    }

    let text: String
    let tone: Tone
    let systemImage: String
}

extension ScanEntry {
    /// Keep can be tapped: the item was read and is not kept or being kept.
    var canKeep: Bool {
        guard scanID != nil, card != nil else { return false }
        switch decision {
        case .open, .keepFailed: return true
        case .keeping, .kept: return false
        }
    }
}
