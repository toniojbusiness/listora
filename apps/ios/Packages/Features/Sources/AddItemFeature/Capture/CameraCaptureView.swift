import DesignSystem
import SwiftUI
import UIKit

/// Guided multi-shot capture: front, back, tag, then flaws and details, one tap each. The current
/// step's prompt sits at the top and the shutter at the bottom, within thumb reach. Every shot is
/// prepared right away (upright, at most 2048 px, no GPS) and checked for blur; a blurry shot asks
/// "Retake or keep?" before the guide moves on.
struct CameraCaptureView: View {
    /// Called with the kept shots and their roles; an empty list means the seller cancelled.
    let onFinish: @MainActor ([(PreparedPhoto, PhotoRole)]) async -> Void
    /// What is being shot, above the step prompt: a kept scan's draft in a run's guided shoot.
    private let header: AnyView?

    @State private var camera: any CameraSource
    @State private var guide: CaptureGuide
    @State private var blurryShot: PreparedPhoto?
    @State private var isTakingPhoto = false
    @State private var cameraProblem: String?
    @State private var isConfirmingDiscard = false
    /// A one-off problem with the last shot, shown instead of the step's instruction.
    @State private var notice: String?
    /// Briefly true after a shot, for the flash.
    @State private var isFlashing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `capacity`: how many more photos the draft has room for.
    init(
        camera: any CameraSource,
        capacity: Int = DraftStore.maxPhotosPerDraft,
        header: AnyView? = nil,
        onFinish: @escaping @MainActor ([(PreparedPhoto, PhotoRole)]) async -> Void,
    ) {
        self.onFinish = onFinish
        self.header = header
        _camera = State(initialValue: camera)
        _guide = State(initialValue: CaptureGuide(capacity: capacity))
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
            VStack(spacing: 0) {
                topBar
                Spacer(minLength: Spacing.md)
                if let blurryShot {
                    BlurWarning {
                        self.blurryShot = nil
                    } onKeep: {
                        guide.accept(blurryShot)
                        self.blurryShot = nil
                    }
                    .transition(.rise)
                }
                bottomBar
            }
            if let cameraProblem {
                cameraProblemView(cameraProblem)
            }
        }
        // The capture screen is always dark, like the system camera, so controls read on photos.
        .environment(\.colorScheme, .dark)
        // Text over the viewfinder stops growing at the first accessibility size so the item stays
        // visible; long-pressing a control shows its label large.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .foregroundStyle(Palette.onMedia)
        .motion(value: blurryShot?.sha256)
        .motion(Motion.snappy, value: guide.step)
        .task {
            do {
                try await camera.start()
            } catch CameraError.accessDenied {
                cameraProblem = "Listora needs the camera to photograph items. Allow camera access in Settings."
            } catch {
                cameraProblem = "The camera isn't available right now."
            }
        }
        .onDisappear { camera.stop() }
        .confirmationDialog("Discard these photos?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard photos", role: .destructive) { finish(with: []) }
            Button("Keep taking photos", role: .cancel) {}
        } message: {
            Text("The \(photoCount) you took so far won't be saved.")
        }
    }

    private var photoCount: String {
        guide.shots.count == 1 ? "photo" : "\(guide.shots.count) photos"
    }

    // MARK: Top: close, done, and the step prompt

    private var topBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Button {
                    if guide.shots.isEmpty {
                        finish(with: [])
                    } else {
                        isConfirmingDiscard = true
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(Typography.headline)
                        .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                        .background(Palette.scrim.color.opacity(0.45), in: Circle())
                }
                .accessibilityLabel("Cancel")
                .accessibilityIdentifier("camera.cancel")
                Spacer()
                Button {
                    finish(with: guide.shots.map { ($0.photo, $0.role) })
                } label: {
                    Text(guide.shots.isEmpty ? "Done" : "Done (\(guide.shots.count))")
                        .font(Typography.headline)
                        .foregroundStyle(guide.shots.isEmpty ? Palette.onMedia : Palette.onBrand)
                        .padding(.horizontal, Spacing.md)
                        .frame(minHeight: Layout.minimumTapTarget)
                        .background(
                            guide.shots.isEmpty
                                ? AnyShapeStyle(Palette.scrim.color.opacity(0.45))
                                : AnyShapeStyle(Palette.brand),
                            in: Capsule(),
                        )
                }
                .disabled(guide.shots.isEmpty)
                .accessibilityIdentifier("camera.done")
            }
            if let header {
                header
            }
            CapturePrompt(step: guide.step, message: notice ?? instruction)
                .accessibilityElement(children: .combine)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach(Array(CaptureGuide.Step.allCases.enumerated()), id: \.element) { index, step in
                        CaptureStepChip(
                            step: step,
                            number: index + 1,
                            taken: guide.count(of: step),
                            isCurrent: guide.step == step,
                        ) {
                            guide.go(to: step)
                        }
                    }
                }
            }
            .scrollClipDisabled()
        }
        .padding(.horizontal, Spacing.md)
        .padding(.top, Spacing.xs)
    }

    private var instruction: String {
        guide.canTakeMore ? guide.step.instruction : "That's all the photos this item can have. Tap Done."
    }

    // MARK: Bottom: last shot, shutter, skip

    private var bottomBar: some View {
        VStack(spacing: Spacing.md) {
            if guide.step == .details {
                FlowLayout(centered: true) {
                    ChoiceChip(
                        "Flaw",
                        systemImage: "exclamationmark.magnifyingglass",
                        isSelected: guide.detailRole == .flaw,
                    ) {
                        guide.detailRole = .flaw
                    }
                    ChoiceChip(
                        "Detail",
                        systemImage: "sparkle.magnifyingglass",
                        isSelected: guide.detailRole == .detail,
                    ) {
                        guide.detailRole = .detail
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("This photo shows")
            }
            HStack(alignment: .center) {
                LastShotThumbnail(shot: guide.shots.last) { guide.removeLastShot() }
                    .frame(width: 64, height: 64)
                Spacer()
                ShutterButton(
                    isReady: !(isTakingPhoto || blurryShot != nil || !guide.canTakeMore || cameraProblem != nil),
                    isTakingPhoto: isTakingPhoto,
                    role: guide.role,
                ) {
                    Task { await takePhoto() }
                }
                Spacer()
                Group {
                    if guide.step == .details {
                        // Holds Skip's place at its size, so the shutter stays centered and the
                        // bar keeps its height (a bare Color.clear takes all the space it is offered).
                        Color.clear.frame(width: 64, height: 64)
                    } else {
                        Button {
                            guide.skip()
                        } label: {
                            Text("Skip")
                                .font(Typography.headline)
                                .fixedSize()
                                .frame(minWidth: 64, minHeight: 64)
                                .contentShape(Rectangle())
                        }
                        .accessibilityShowsLargeContentViewer()
                        .accessibilityLabel("Skip \(guide.step.title.lowercased())")
                        .accessibilityIdentifier("camera.skip")
                    }
                }
                .frame(minWidth: 64, minHeight: 64)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.sm)
        .background(
            LinearGradient(
                colors: [.clear, Palette.scrim.color.opacity(0.65)],
                startPoint: .top,
                endPoint: .bottom,
            )
            .ignoresSafeArea(edges: .bottom),
        )
    }

    private func cameraProblemView(_ message: String) -> some View {
        EmptyStateView(
            systemImage: "camera.badge.ellipsis",
            tone: .actionNeeded,
            title: "No camera",
            message: message,
            action: .init(guide.shots.isEmpty ? "Close" : "Keep \(photoCount)") {
                finish(with: guide.shots.map { ($0.photo, $0.role) })
            },
        )
    }

    private func takePhoto() async {
        isTakingPhoto = true
        notice = nil
        defer { isTakingPhoto = false }
        do {
            let data = try await camera.capture()
            flash()
            Haptics.play(.tap)
            let photo = try await Task.detached(priority: .userInitiated) { try PhotoPreparation.prepare(data) }.value
            if photo.looksBlurry {
                Haptics.play(.warning)
                blurryShot = photo
            } else {
                guide.accept(photo)
            }
        } catch {
            Haptics.play(.failure)
            notice = "That photo couldn't be taken. Try again."
        }
    }

    private func flash() {
        guard !reduceMotion else { return }
        isFlashing = true
        withAnimation(.easeOut(duration: 0.25)) {
            isFlashing = false
        }
    }

    private func finish(with shots: [(PreparedPhoto, PhotoRole)]) {
        camera.stop()
        if !shots.isEmpty {
            Haptics.play(.success)
        }
        Task { await onFinish(shots) }
    }
}
