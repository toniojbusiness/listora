import APIClient
import Core
import Foundation
import Observation
import os

/// Spoken (or typed) corrections on the review: hold to talk, the transcript parsed on the
/// device, the phrases it could not map sent to the server's text model as text, and every
/// proposed change shown as a chip the seller accepts or dismisses, and can undo after
/// accepting. Nothing changes on the item until the seller accepts it; an accepted change is
/// their own edit (provenance "You") and is saved with the review's other edits.
@MainActor
@Observable
final class VoiceCorrectionModel {
    enum Phase: Equatable {
        case idle
        /// The talk button is held; the transcript so far.
        case listening(String)
        /// Listora's text model is reading the phrases the parser could not map.
        case interpreting
    }

    private(set) var phase: Phase = .idle
    private(set) var proposals: [VoiceProposal] = []
    /// What the seller said or typed last, shown above its proposals.
    private(set) var heard: String?
    private(set) var notice: VoiceNotice?
    /// The "type instead" field, for when voice is off or the seller prefers typing.
    var typed = ""
    var showsTyping = false

    private let target: any VoiceCorrectionTarget
    private let transcriber: any VoiceTranscriber
    private let log = Logger(subsystem: "com.listora.app", category: "voice")
    private var nextID = 0
    /// The phrases waiting for Listora's text model, and the request's idempotency key.
    private var pending: (text: String, key: String)?

    init(target: any VoiceCorrectionTarget, transcriber: any VoiceTranscriber) {
        self.target = target
        self.transcriber = transcriber
    }

    var isListening: Bool {
        if case .listening = phase {
            return true
        }
        return false
    }

    var pendingCount: Int {
        proposals.count { !$0.isApplied }
    }

    /// The tray shows: something was heard, proposed, or needs saying.
    var hasContent: Bool {
        heard != nil || !proposals.isEmpty || notice != nil || phase == .interpreting
    }

    // MARK: Listening

    /// The talk button went down. Without permission yet, it explains and offers to ask; with
    /// permission turned off, it says where to turn it on and opens the typing field.
    func pressBegan() {
        guard phase == .idle else { return }
        switch transcriber.authorization {
        case .authorized:
            break
        case .notDetermined:
            notice = VoiceNotice(
                message: "Hold the mic and say what to change, like \"size medium, paid four dollars at Goodwill\". " +
                    "Listora needs the microphone and speech recognition for that.",
                tone: .info,
                action: .allowVoice,
            )
            return
        default:
            showUnavailable(transcriber.authorization)
            return
        }
        do {
            try transcriber.start { [weak self] text in
                guard let self, isListening else { return }
                phase = .listening(text)
            }
            notice = nil
            phase = .listening("")
        } catch {
            log.error("Voice: listening did not start: \(String(describing: error), privacy: .public)")
            showUnavailable(transcriber.authorization == .authorized ? .unavailable : transcriber.authorization)
        }
    }

    /// The talk button came up: what was said becomes proposals.
    func pressEnded() async {
        guard isListening else { return }
        let transcript: String
        do {
            transcript = try await transcriber.finish()
        } catch {
            phase = .idle
            notice = VoiceNotice(
                message: "Listora couldn't make that out. Hold the mic and try again, or type it.",
                tone: .warning,
                action: nil,
            )
            return
        }
        phase = .idle
        await handle(transcript)
    }

    /// The talk button left the screen while held (the seller scrolled away, the app went to the
    /// background): nothing heard is used.
    func cancelListening() {
        guard isListening else { return }
        transcriber.cancel()
        phase = .idle
    }

    func allowVoice() async {
        let authorization = await transcriber.requestAuthorization()
        if authorization == .authorized {
            notice = VoiceNotice(message: "Voice is on. Hold the mic while you talk.", tone: .info, action: nil)
        } else {
            showUnavailable(authorization)
        }
    }

    private func showUnavailable(_ authorization: SpeechAuthorization) {
        let message = switch authorization {
        case .microphoneDenied:
            "Listora can't use the microphone. Turn it on in Settings, or type your correction."
        case .speechDenied:
            "Speech recognition is off for Listora. Turn it on in Settings, or type your correction."
        case .restricted:
            "Voice input isn't allowed on this iPhone. Type your correction instead."
        case .unavailable, .notDetermined, .authorized:
            "Voice input isn't available right now. Type your correction instead."
        }
        let canChangeInSettings = authorization == .microphoneDenied || authorization == .speechDenied
        notice = VoiceNotice(message: message, tone: .warning, action: canChangeInSettings ? .openSettings : nil)
        showsTyping = true
    }

    // MARK: Typing

    func submitTyped() async {
        let text = typed
        typed = ""
        await handle(text)
    }

    // MARK: Interpreting

    /// Parses what was said on the device and proposes its changes; the phrases the parser could
    /// not map go to Listora's text model as text.
    func handle(_ transcript: String) async {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            notice = VoiceNotice(
                message: "Listora didn't hear anything. Hold the mic while you talk.",
                tone: .warning,
                action: nil,
            )
            return
        }
        heard = text
        notice = nil
        let parse = VoiceCorrectionParser.parse(text, context: target.voiceContext)
        let unchanged = propose(parse.changes, fromAI: false)
        let unmatched = parse.unmatched.joined(separator: ", ")
        if !unmatched.isEmpty {
            pending = (String(unmatched.prefix(Self.maxTranscriptLength)), UUID().uuidString.lowercased())
            await interpretPending()
        } else if parse.changes.isEmpty || unchanged == parse.changes.count {
            notice = VoiceNotice(message: "Those details are already set.", tone: .info, action: nil)
        }
    }

    /// The contract's limit on the text sent (`VoiceCorrectionRequest`).
    static let maxTranscriptLength = 500

    /// Asks Listora's text model again after a failure; the same idempotency key replays an
    /// answer that arrived after all instead of paying for a second one.
    func retry() async {
        await interpretPending()
    }

    private func interpretPending() async {
        guard let pending, phase == .idle else { return }
        notice = nil
        phase = .interpreting
        defer { phase = .idle }
        do {
            let changes = try await target.interpretVoice(pending.text, idempotencyKey: pending.key)
            self.pending = nil
            if changes.isEmpty {
                notice = VoiceNotice(
                    message: "Listora couldn't match \"\(pending.text)\" to a detail. Edit it by hand.",
                    tone: .info,
                    action: nil,
                )
            } else if propose(changes, fromAI: true) == changes.count {
                notice = VoiceNotice(message: "Those details are already set.", tone: .info, action: nil)
            }
        } catch {
            log.error("Voice: interpreting failed: \(error.code, privacy: .public) \(error.message, privacy: .public)")
            let canRetry = error.retryable || error.statusCode == nil
            if !canRetry {
                self.pending = nil
            }
            notice = VoiceNotice(
                message: proposals.isEmpty ? error.message : "\(error.message) The rest of what you said is below.",
                tone: .danger,
                action: canRetry ? .retry : nil,
            )
        }
    }

    /// Adds `changes` as pending proposals. A pending proposal to the same detail is replaced,
    /// and a change that would change nothing is left out. Answers how many were left out.
    @discardableResult
    private func propose(_ changes: [VoiceChange], fromAI: Bool) -> Int {
        var unchanged = 0
        for change in changes {
            if target.isAlreadySet(change) {
                unchanged += 1
                continue
            }
            proposals.removeAll { !$0.isApplied && replaces(change, $0.change) }
            nextID += 1
            proposals.append(VoiceProposal(id: nextID, change: change, fromAI: fromAI, state: .pending))
        }
        return unchanged
    }

    /// Whether `new` makes `old` pointless: both set the same thing, or both add the same entry.
    private func replaces(_ new: VoiceChange, _ old: VoiceChange) -> Bool {
        switch (new, old) {
        case let (.add(key, entry), .add(otherKey, other)):
            key == otherKey && entry.caseInsensitiveCompare(other) == .orderedSame
        case (.add, _), (_, .add):
            false
        default:
            new.target == old.target
        }
    }

    // MARK: Accepting

    func accept(_ id: VoiceProposal.ID) {
        guard let index = proposals.firstIndex(where: { $0.id == id }), !proposals[index].isApplied else { return }
        let change = proposals[index].change
        let undo = target.apply(change)
        proposals[index].state = .applied(undo)
        // An earlier accepted change to the same detail is now overwritten; undoing this one
        // goes back to it.
        proposals.removeAll { $0.id != id && $0.isApplied && replaces(change, $0.change) }
    }

    func acceptAll() {
        for proposal in proposals where !proposal.isApplied {
            accept(proposal.id)
        }
    }

    func dismiss(_ id: VoiceProposal.ID) {
        proposals.removeAll { $0.id == id && !$0.isApplied }
    }

    /// Takes an accepted change back; it is offered again, pending.
    func undo(_ id: VoiceProposal.ID) {
        guard let index = proposals.firstIndex(where: { $0.id == id }),
              case let .applied(undo) = proposals[index].state
        else { return }
        target.undo(undo)
        proposals[index].state = .pending
    }

    /// Closes the tray. Pending proposals are dropped; accepted ones stay applied.
    func close() {
        proposals = []
        heard = nil
        notice = nil
        pending = nil
        showsTyping = false
    }
}

/// One proposed change of a spoken correction, pending or accepted.
struct VoiceProposal: Equatable, Identifiable {
    enum State: Equatable {
        case pending
        /// Applied; the undo takes it back.
        case applied(VoiceUndo)
    }

    let id: Int
    let change: VoiceChange
    /// From Listora's text model rather than the rules on this iPhone.
    let fromAI: Bool
    var state: State

    var isApplied: Bool {
        if case .applied = state {
            return true
        }
        return false
    }
}

/// A message under the talk button, with what the seller can do about it.
struct VoiceNotice: Equatable {
    enum Tone: Equatable {
        case info
        case warning
        case danger
    }

    enum Action: Equatable {
        /// Ask for the microphone and speech recognition (the system prompts).
        case allowVoice
        /// Permission was turned off: the Settings app is where it goes back on.
        case openSettings
        /// Ask Listora's text model again (same request, so it is not paid twice).
        case retry
    }

    let message: String
    let tone: Tone
    let action: Action?
}
