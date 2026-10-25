import DesignSystem
import SwiftUI
import UIKit

/// What a spoken correction did, above the review's bottom bar: the live transcript while the
/// seller talks, then each proposed change as a chip to accept or dismiss (and undo once
/// accepted), any message with its way forward, and the typing field.
struct VoiceTray: View {
    @Bindable var voice: VoiceCorrectionModel
    @Environment(\.openURL) private var openURL
    @FocusState private var isTypingFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if voice.pendingCount > 0 {
                // Capped, so the review above keeps most of the screen; more chips scroll.
                ScrollView {
                    FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) { chips }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 104)
            } else if !voice.proposals.isEmpty {
                // Everything is accepted: one row, so the seller sees the review again.
                ScrollView(.horizontal) {
                    HStack(spacing: Spacing.xs) { chips }
                }
                .scrollIndicators(.hidden)
            }
            if let notice = voice.notice {
                noticeView(notice)
            }
            if voice.showsTyping {
                typingField
            }
            actions
        }
        .cardStyle(.outlined, padding: Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice.tray")
    }

    private var chips: some View {
        ForEach(Array(voice.proposals.enumerated()), id: \.element.id) { index, proposal in
            VoiceProposalChip(
                proposal: proposal,
                index: index,
                onAccept: { voice.accept(proposal.id) },
                onDismiss: { voice.dismiss(proposal.id) },
                onUndo: { voice.undo(proposal.id) },
            )
        }
    }

    @ViewBuilder
    private var header: some View {
        switch voice.phase {
        case let .listening(transcript):
            Label(transcript.isEmpty ? "Listening..." : transcript, systemImage: "waveform")
                .font(Typography.callout)
                .foregroundStyle(transcript.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                .accessibilityIdentifier("voice.transcript")
        case .interpreting:
            HStack(spacing: Spacing.xs) {
                ProgressView().controlSize(.small)
                Text("Working out the rest...")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("voice.interpreting")
        case .idle:
            if let heard = voice.heard {
                Text("You said \"\(heard)\"")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("voice.heard")
            }
        }
    }

    private func noticeView(_ notice: VoiceNotice) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Label(notice.message, systemImage: icon(notice.tone))
                .font(Typography.caption)
                .foregroundStyle(color(notice.tone))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("voice.notice")
            if let action = notice.action {
                Button(title(action)) {
                    switch action {
                    case .allowVoice: Task { await voice.allowVoice() }
                    case .openSettings:
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            openURL(url)
                        }
                    case .retry: Task { await voice.retry() }
                    }
                }
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityIdentifier("voice.noticeAction")
            }
        }
    }

    private var typingField: some View {
        HStack(spacing: Spacing.xs) {
            TextField("Type a correction, like \"size M\"", text: $voice.typed)
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .submitLabel(.done)
                .focused($isTypingFocused)
                .onSubmit { Task { await voice.submitTyped() } }
                .padding(.horizontal, Spacing.sm)
                .frame(minHeight: Layout.minimumTapTarget)
                .background(Palette.surfaceSecondary, in: RoundedRectangle(cornerRadius: Radius.medium))
                .accessibilityIdentifier("voice.typed")
            Button("Use") { Task { await voice.submitTyped() } }
                .buttonStyle(.listora(.secondary, size: .compact))
                .disabled(voice.typed.trimmingCharacters(in: .whitespaces).isEmpty || voice.phase != .idle)
                .accessibilityIdentifier("voice.typedUse")
        }
    }

    private var actions: some View {
        HStack(spacing: Spacing.xs) {
            if voice.pendingCount > 1 {
                Button("Accept all (\(voice.pendingCount))", action: voice.acceptAll)
                    .buttonStyle(.listora(.primary, size: .compact))
                    .accessibilityIdentifier("voice.acceptAll")
            }
            Spacer(minLength: 0)
            Button("Done", action: voice.close)
                .buttonStyle(.listora(.tertiary, size: .compact))
                .disabled(voice.isListening)
                .accessibilityIdentifier("voice.done")
        }
    }

    private func icon(_ tone: VoiceNotice.Tone) -> String {
        switch tone {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .danger: "exclamationmark.octagon.fill"
        }
    }

    private func color(_ tone: VoiceNotice.Tone) -> ColorToken {
        switch tone {
        case .info: Palette.textSecondary
        case .warning: Palette.warning
        case .danger: Palette.danger
        }
    }

    private func title(_ action: VoiceNotice.Action) -> String {
        switch action {
        case .allowVoice: "Turn on voice"
        case .openSettings: "Open Settings"
        case .retry: "Try again"
        }
    }
}

/// One proposed change: "Size: M" with Accept and Dismiss, or, once accepted, a check and Undo.
/// Changes from Listora's text model carry its sparkle.
struct VoiceProposalChip: View {
    let proposal: VoiceProposal
    let index: Int
    let onAccept: () -> Void
    let onDismiss: () -> Void
    let onUndo: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: Spacing.xxs) {
                Image(systemName: proposal.isApplied ? "checkmark" : proposal.fromAI ? "sparkles" : "mic.fill")
                    .imageScale(.small)
                    .accessibilityHidden(true)
                Text(proposal.change.summary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(Typography.subheadline.weight(.semibold))
            .foregroundStyle(proposal.isApplied ? Palette.onBrand : Palette.textPrimary)
            .padding(.leading, Spacing.sm)
            .padding(.trailing, Spacing.xxs)
            .padding(.vertical, Spacing.xxs)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(label)
            .accessibilityIdentifier("voice.proposal.\(index)")
            if proposal.isApplied {
                iconButton("Undo", systemImage: "arrow.uturn.backward", identifier: "undo", action: onUndo)
            } else {
                iconButton("Accept", systemImage: "checkmark.circle.fill", identifier: "accept", action: onAccept)
                iconButton("Dismiss", systemImage: "xmark.circle.fill", identifier: "dismiss", action: onDismiss)
            }
        }
        .padding(.trailing, Spacing.xxs)
        .background(proposal.isApplied ? Palette.brand : Palette.brandSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(proposal.isApplied ? Color.clear : Palette.brand.color, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private var label: String {
        let source = proposal.fromAI ? ", understood by Listora AI" : ""
        return proposal.isApplied ? "\(proposal.change.summary), accepted" : "\(proposal.change.summary)\(source)"
    }

    private func iconButton(
        _ title: String,
        systemImage: String,
        identifier: String,
        action: @escaping () -> Void,
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(Typography.headline)
                .foregroundStyle(proposal.isApplied ? Palette.onBrand : Palette.brand)
                .frame(width: 36, height: Layout.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) \(proposal.change.summary)")
        .accessibilityIdentifier("voice.\(identifier).\(index)")
    }
}

/// The microphone: hold it and talk, let go to see what Listora understood. VoiceOver users
/// double-tap to start and again to stop.
struct TalkButton: View {
    let voice: VoiceCorrectionModel
    @State private var isPressed = false

    var body: some View {
        let listening = voice.isListening
        Label(listening ? "Listening" : "Hold to talk", systemImage: listening ? "waveform" : "mic.fill")
            .font(Typography.subheadline.weight(.semibold))
            .foregroundStyle(listening ? Palette.onBrand : Palette.brand)
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: Layout.compactButtonHeight)
            .background(listening ? Palette.brand : Palette.brandSoft, in: Capsule())
            .contentShape(Capsule())
            .opacity(voice.phase == .interpreting ? 0.45 : 1)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !isPressed else { return }
                        isPressed = true
                        voice.pressBegan()
                    }
                    .onEnded { _ in
                        isPressed = false
                        Task { await voice.pressEnded() }
                    },
            )
            .sensoryFeedback(.impact(weight: .light), trigger: listening)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(listening ? "Stop listening" : "Talk to correct details")
            .accessibilityHint("Hold and say what to change, like size medium, paid four dollars at Goodwill.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if voice.isListening {
                    Task { await voice.pressEnded() }
                } else {
                    voice.pressBegan()
                }
            }
            .accessibilityIdentifier("voice.talk")
            .onDisappear { voice.cancelListening() }
    }
}
