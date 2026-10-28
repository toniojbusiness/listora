import APIClient
import Foundation
import Observation

/// Settings > Description style: the instructions Listora's AI follows when it writes the
/// seller's Depop drafts. It starts as Listora's default; the seller edits it into their own and
/// saves it on the server, or goes back to the default. Analyses made after a save follow it.
@MainActor
@Observable
public final class DescriptionStyleModel {
    public enum Phase: Equatable {
        /// Nothing read yet.
        case loading
        case loaded
        /// The style could not be read; `message` is safe to show.
        case failed(message: String)
    }

    /// Characters a style may have (the contract's limit).
    public static let maxLength = 4000

    public private(set) var phase: Phase = .loading
    public private(set) var style: DescriptionStyle?
    /// The editor's text, filled from the style once it is read.
    public var draft = ""
    public private(set) var isSaving = false
    /// Why the last save failed, safe to show; nothing was saved then.
    public private(set) var saveError: String?

    private let service: any DescriptionStyleService

    public init(service: any DescriptionStyleService) {
        self.service = service
    }

    /// Reads the style and fills the editor with it.
    public func load() async {
        if style == nil {
            phase = .loading
        }
        do {
            let loaded = try await service.style()
            style = loaded
            draft = loaded.depop
            saveError = nil
            phase = .loaded
        } catch {
            // A style already shown stays; the next load tries again.
            if style == nil {
                phase = .failed(message: error.message)
            }
        }
    }

    /// True when the editor differs from what the server has.
    public var hasChanges: Bool {
        guard let style else { return false }
        return trimmedDraft != style.depop
    }

    /// Characters in the editor once trimmed, counted as the server counts them (Unicode scalars,
    /// so an emoji such as ❤️ is two).
    public var length: Int {
        trimmedDraft.unicodeScalars.count
    }

    /// Save is possible: something changed, it is not blank, and it fits.
    public var canSave: Bool {
        hasChanges && !trimmedDraft.isEmpty && length <= Self.maxLength && !isSaving
    }

    /// Saves the editor's text as the seller's own style; true once the server has it.
    public func save() async -> Bool {
        guard canSave else { return false }
        return await send(trimmedDraft)
    }

    /// Goes back to Listora's default style; true once the server has it.
    public func useDefault() async -> Bool {
        guard !isSaving else { return false }
        return await send(nil)
    }

    private func send(_ depop: String?) async -> Bool {
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let saved = try await service.save(depop: depop)
            style = saved
            draft = saved.depop
            phase = .loaded
            return true
        } catch {
            saveError = error.message
            return false
        }
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
