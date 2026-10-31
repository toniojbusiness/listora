import Core
import DesignSystem
import SwiftUI

/// Scan mode's camera at the bins (docs/features/thrift-scan.md): one shot of the item in hand,
/// read at once, its card over the bottom while the viewfinder stays live. Keep saves the item
/// as a draft and Put back passes on it; either one closes the card, back to the camera for the
/// next shot, with a brief line saying what happened. Shooting the next item without choosing
/// puts the last one back. Hold the
/// mic to add a note, tap Tag to shoot the tag close-up. Done closes the camera and keeps the
/// run; Finish offers the register's checkout, or ending the run without buying.
struct ScanCaptureView: View {
    let run: ScanRunModel
    let voice: ScanVoice
    /// The owner in Test mode sees the run's measurements; sellers never see timings.
    let showsMeasurements: Bool
    let meter: InteractionMeter
    let onDone: @MainActor () -> Void
    let onCheckout: @MainActor () -> Void
    let onEnd: @MainActor () async -> Void

    @State private var camera: any CameraSource
    @State private var isTakingPhoto = false
    @State private var cameraProblem: String?
    @State private var isFlashing = false
    @State private var isConfirmingEnd = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        camera: any CameraSource,
        run: ScanRunModel,
        voice: ScanVoice,
        showsMeasurements: Bool,
        meter: InteractionMeter,
        onDone: @escaping @MainActor () -> Void,
        onCheckout: @escaping @MainActor () -> Void,
        onEnd: @escaping @MainActor () async -> Void,
    ) {
        _camera = State(initialValue: camera)
        self.run = run
        self.voice = voice
        self.showsMeasurements = showsMeasurements
        self.meter = meter
        self.onDone = onDone
        self.onCheckout = onCheckout
        self.onEnd = onEnd
    }

    var body: some View {
        ZStack {
            Palette.mediaBackground.color.ignoresSafeArea()
            camera.preview()
                .ignoresSafeArea()
                .accessibilityHidden(true)
            Palette.onMedia.color
                .opacity(isFlashing ? 0.6 : 0)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            VStack(spacing: Spacing.xs) {
                topBar
                Spacer(minLength: Spacing.md)
                prompts
                if let entry = run.current {
                    ScanCardView(
                        entry: entry,
                        onKeep: { Task { await run.keepAndContinue(entry.id) } },
                        onPutBack: { run.putBack(entry.id) },
                        onClose: { run.closeCard(entry.id) },
                        onTag: { run.startTagShot() },
                        onRetry: { Task { await run.retry(entry.id) } },
                    )
                    .foregroundStyle(Palette.textPrimary)
                    .padding(.horizontal, Spacing.md)
                    .transition(.rise)
                    .id(entry.id)
                    .onDisappear { run.cardClosed(entry.id) }
                } else if let confirmation = run.confirmation, let line = run.confirmationLine {
                    ScanConfirmationView(line: line)
                        .transition(.opacity)
                        .id(confirmation.id)
                        .task(id: line) {
                            AccessibilityNotification.Announcement(line.text).post()
                            guard line.tone != .working else { return }
                            let shown = line.tone == .failed
                                ? ScanConfirmation.failureShownFor : ScanConfirmation.shownFor
                            try? await Task.sleep(for: shown)
                            withAnimation(Motion.snappy) { run.clearConfirmation(confirmation.id) }
                        }
                }
                if !run.entries.isEmpty {
                    ScanTray(entries: run.entries, currentID: run.currentID) { run.select($0) }
                }
                bottomBar
            }
            if let cameraProblem {
                EmptyStateView(
                    systemImage: "camera.badge.ellipsis",
                    tone: .actionNeeded,
                    title: "No camera",
                    message: cameraProblem,
                    action: .init("Close") { onDone() },
                )
            }
        }
        .environment(\.colorScheme, .dark)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .foregroundStyle(Palette.onMedia)
        .motion(Motion.snappy, value: run.currentID)
        .motion(Motion.snappy, value: run.confirmation)
        .measuresInteraction(meter, session: run.meterSession)
        .task {
            do {
                try await camera.start()
            } catch CameraError.accessDenied {
                cameraProblem = "Listora needs the camera to scan items. Allow camera access in Settings."
            } catch {
                cameraProblem = "The camera isn't available right now."
            }
        }
        .onDisappear {
            camera.stop()
            voice.cancel()
        }
        .confirmationDialog("Finish this run?", isPresented: $isConfirmingEnd, titleVisibility: .visible) {
            Button("Check out") { onCheckout() }
            Button("End without checking out", role: .destructive) {
                Task { await onEnd() }
            }
            Button("Keep scanning", role: .cancel) {}
        } message: {
            Text(endMessage)
        }
    }

    private var endMessage: String {
        let kept = run.keptCount == 1 ? "the 1 item you kept" : "the \(run.keptCount) items you kept"
        return "Check out to enter what you paid for \(kept) and see the haul's estimated profit. "
            + "Either way the items not kept are skipped and can't be kept after this."
    }

    // MARK: Top

    private var topBar: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            HStack {
                Button(action: onDone) {
                    Text("Done")
                        .font(Typography.headline)
                        .padding(.horizontal, Spacing.md)
                        .frame(minHeight: Layout.minimumTapTarget)
                        .background(Palette.scrim.color.opacity(0.45), in: Capsule())
                }
                .accessibilityHint("Closes the camera. The run goes on until you end it.")
                .accessibilityIdentifier("scanCamera.done")
                Spacer()
                Text(runSummary)
                    .font(Typography.emphasis)
                    .padding(.horizontal, Spacing.sm)
                    .frame(minHeight: Layout.minimumTapTarget)
                    .background(Palette.scrim.color.opacity(0.45), in: Capsule())
                    .accessibilityIdentifier("scanCamera.summary")
                Spacer()
                Button("Finish") { isConfirmingEnd = true }
                    .font(Typography.headline)
                    .padding(.horizontal, Spacing.md)
                    .frame(minHeight: Layout.minimumTapTarget)
                    .background(Palette.scrim.color.opacity(0.45), in: Capsule())
                    .disabled(run.entries.isEmpty)
                    .accessibilityIdentifier("scanCamera.end")
            }
            if showsMeasurements, let line = ScanMeasurements(run: run, meter: meter).line {
                HStack(spacing: Spacing.xs) {
                    TestingTag()
                    Text(line).font(Typography.metadata)
                }
                .padding(.horizontal, Spacing.xs)
                .background(Palette.scrim.color.opacity(0.45), in: Capsule())
                .accessibilityIdentifier("scanCamera.measurements")
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.top, Spacing.xs)
    }

    private var runSummary: String {
        let scanned = run.entries.count == 1 ? "1 scanned" : "\(run.entries.count) scanned"
        return run.keptCount == 0 ? scanned : "\(scanned) · \(run.keptCount) kept"
    }

    @ViewBuilder
    private var prompts: some View {
        if run.tagShotFor != nil {
            HStack(spacing: Spacing.sm) {
                Label("Shoot the tag up close", systemImage: "tag.fill").font(Typography.emphasis)
                Spacer(minLength: Spacing.xs)
                Button("Cancel") { run.cancelTagShot() }
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .fixedSize()
            }
            .cardStyle(padding: Spacing.sm)
            .padding(.horizontal, Spacing.md)
            .transition(.rise)
        } else if run.current != nil, let line = run.confirmationLine, line.tone == .failed {
            // A Keep that failed after the next card came up: said above it until it goes.
            ScanConfirmationView(line: line)
        } else if voice.isListening {
            Label(voice.heard.isEmpty ? "Listening..." : voice.heard, systemImage: "waveform")
                .font(Typography.emphasis)
                .padding(Spacing.sm)
                .background(Palette.scrim.color.opacity(0.6), in: Capsule())
        } else if let notice = voice.notice {
            Text(notice)
                .font(Typography.footnote)
                .padding(Spacing.sm)
                .background(Palette.scrim.color.opacity(0.6), in: Capsule())
        } else if let note = run.pendingNote {
            Label("Note for the next item: \(note)", systemImage: "text.bubble")
                .font(Typography.footnote)
                .padding(Spacing.sm)
                .background(Palette.scrim.color.opacity(0.6), in: Capsule())
        }
    }

    // MARK: Bottom

    private var bottomBar: some View {
        HStack(alignment: .center) {
            ScanMicButton(voice: voice) { note in
                await run.addNote(note)
            }
            .frame(width: 72)
            Spacer()
            ShutterButton(
                isReady: !(isTakingPhoto || cameraProblem != nil || run.isEnded),
                isTakingPhoto: isTakingPhoto,
                role: run.tagShotFor == nil ? .front : .tag,
            ) {
                Task { await takePhoto() }
            }
            .accessibilityLabel(run.tagShotFor == nil ? "Scan an item" : "Shoot the tag")
            Spacer()
            Color.clear.frame(width: 72, height: 1)
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.xs)
        .padding(.bottom, Spacing.sm)
        .background(
            LinearGradient(colors: [.clear, Palette.scrim.color.opacity(0.65)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .bottom),
        )
    }

    // MARK: Actions

    /// Takes the shot and hands it to the run, which reads it while the camera is ready for the
    /// next item at once.
    private func takePhoto() async {
        isTakingPhoto = true
        let data: Data
        do {
            data = try await camera.capture()
        } catch {
            isTakingPhoto = false
            Haptics.play(.failure)
            return
        }
        isTakingPhoto = false
        flash()
        Haptics.play(.tap)
        await run.shoot(data)
    }

    private func flash() {
        guard !reduceMotion else { return }
        isFlashing = true
        withAnimation(.easeOut(duration: 0.25)) {
            isFlashing = false
        }
    }
}

/// The scan camera's microphone: hold and talk, let go to add the note.
private struct ScanMicButton: View {
    let voice: ScanVoice
    let onNote: @MainActor (String) async -> Void
    @State private var isPressed = false

    var body: some View {
        let listening = voice.isListening
        VStack(spacing: 2) {
            Image(systemName: listening ? "waveform" : "mic.fill").font(Typography.title3)
            Text(listening ? "Listening" : "Hold to talk").font(Typography.label).fixedSize()
        }
        .frame(minWidth: 64, minHeight: 64)
        .background(listening ? Palette.brand.color : Palette.scrim.color.opacity(0.45), in: Circle())
        .contentShape(Circle())
        .opacity(voice.isAvailable ? 1 : 0.4)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isPressed else { return }
                    isPressed = true
                    voice.pressBegan()
                }
                .onEnded { _ in
                    isPressed = false
                    Task {
                        if let note = await voice.pressEnded() {
                            await onNote(note)
                        }
                    }
                },
        )
        .sensoryFeedback(.impact(weight: .light), trigger: listening)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(listening ? "Stop listening" : "Add a note by voice")
        .accessibilityHint("Hold and say something about the item, like medium, small stain.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            if voice.isListening {
                Task {
                    if let note = await voice.pressEnded() {
                        await onNote(note)
                    }
                }
            } else {
                voice.pressBegan()
            }
        }
        .accessibilityIdentifier("scanCamera.mic")
    }
}
