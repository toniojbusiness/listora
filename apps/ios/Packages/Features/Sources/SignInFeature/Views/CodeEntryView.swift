import DesignSystem
import SwiftUI

/// The second step: the code from the email (or, in Dev builds, the API's log). It takes the code
/// typed, pasted, or autofilled from the keyboard's suggestion, and signs in as soon as a whole
/// code arrives at once. A new code can be requested after a short cooldown.
struct CodeEntryView: View {
    @Bindable var model: SignInModel
    @FocusState private var codeFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(model.kind == .developer ? "Enter the code" : "Check your email")
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(sentTo)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("signIn.sentTo")
                }
                VStack(alignment: .leading, spacing: Spacing.md) {
                    ListoraTextField("Code", hint: codeHint) {
                        // No placeholder: sample digits (or the word "Code") at this size read as a
                        // code already entered. The field's label above names it.
                        TextField(
                            "Code",
                            text: Binding(get: { model.code }, set: { enter($0) }),
                            prompt: Text(verbatim: ""),
                        )
                        .font(Typography.priceLarge)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .focused($codeFocused)
                        .accessibilityIdentifier("signIn.code")
                    }
                    // Under the field it fills, so a code copied from the email is one tap away.
                    PasteButton(payloadType: String.self) { strings in
                        Task { @MainActor in enter(strings.first ?? "") }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    .tint(Palette.brand.color)
                    .disabled(model.isWorking)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityIdentifier("signIn.paste")
                    if let problem = model.problem {
                        Banner(
                            problem.message,
                            tone: .failed,
                            action: bannerAction(for: problem),
                            identifier: "signIn.message",
                        )
                    }
                }
                .cardStyle(.elevated)
                resend
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.lg)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        // Pinned above the keyboard, so Sign in stays in reach at every text size.
        .bottomActionBar {
            Button("Sign in", action: signIn)
                .buttonStyle(.listoraPrimary)
                .disabled(!model.canSignIn)
                .loading(model.isWorking)
                .accessibilityIdentifier("signIn.signIn")
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle("Sign in")
        .onAppear { codeFocused = true }
    }

    /// "Send a new code", counting down while the last one is new.
    private var resend: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let wait = model.resendWait(at: context.date)
            VStack(spacing: Spacing.xs) {
                Button(wait > 0 ? "Send a new code in \(Self.clock(wait))" : "Send a new code") {
                    Task { await model.resendCode() }
                }
                .buttonStyle(.listoraTertiary)
                .disabled(wait > 0 || model.isWorking)
                .accessibilityIdentifier("signIn.resend")
                Button("Use a different email") { model.startOver() }
                    .buttonStyle(.listoraTertiary)
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("signIn.differentEmail")
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func enter(_ text: String) {
        if model.enterCode(text) {
            signIn()
        }
    }

    private func signIn() {
        guard model.canSignIn else { return }
        Task { await model.signIn() }
    }

    /// The problem's way forward, when there is one beyond typing the code again.
    private func bannerAction(for problem: SignInProblem) -> Banner.Action? {
        switch problem.kind {
        case .offline:
            .init("Try again", identifier: "signIn.retry") { signIn() }
        case .codeExpired:
            model.resendWait(at: .now) == 0
                ? .init("Send a new code", identifier: "signIn.messageResend") { Task { await model.resendCode() } }
                : nil
        case .wrongCode, .emailNotAllowed, .rateLimited, .other:
            nil
        }
    }

    private var sentTo: String {
        model.kind == .developer
            ? "The local API printed a sign-in code for \(model.email) to its log."
            : "We sent a sign-in code to \(model.email). It works for 10 minutes."
    }

    private var codeHint: String {
        model.kind == .developer
            ? "6 digits, from the API's log."
            : "Paste it, or tap the code above the keyboard when it appears."
    }

    static func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
