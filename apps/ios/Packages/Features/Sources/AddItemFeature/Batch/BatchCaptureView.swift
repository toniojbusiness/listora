import Core
import DesignSystem
import SwiftUI

/// Batch capture: the seller shoots a whole haul in one go, front, back, and tag of each item,
/// and Listora tells the items apart as the photos come in. "Next item" (or a swipe to the left)
/// starts the next item by hand. Every photo is saved on this iPhone as it is taken; Done groups
/// them for the seller to check.
struct BatchCaptureView: View {
    /// Called when the session ends; `kept` is false when the seller discarded every photo.
    let onFinish: @MainActor (_ kept: Bool) async -> Void

    @State private var camera: any CameraSource
    @State private var model: BatchCaptureModel
    @State private var isTakingPhoto = false
    @State private var isFinishing = false
    @State private var cameraProblem: String?
    @State private var notice: String?
    @State private var blurryShotID: String?
    @State private var isConfirmingDiscard = false
    @State private var isFlashing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        camera: any CameraSource,
        model: BatchCaptureModel,
        onFinish: @escaping @MainActor (_ kept: Bool) async -> Void,
    ) {
        self.onFinish = onFinish
        _camera = State(initialValue: camera)
        _model = State(initialValue: model)
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
                if blurryShotID != nil, blurryShotID == model.lastShot?.id {
                    blurNotice.transition(.rise)
                }
                bottomBar
            }
            if let cameraProblem {
                EmptyStateView(
                    systemImage: "camera.badge.ellipsis",
                    tone: .actionNeeded,
                    title: "No camera",
                    message: cameraProblem,
                    action: .init(model.shots.isEmpty ? "Close" : "Check the \(itemsText)") { finish(kept: true) },
                )
            }
        }
        .environment(\.colorScheme, .dark)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .foregroundStyle(Palette.onMedia)
        .motion(value: blurryShotID)
        .motion(Motion.snappy, value: model.itemNumber)
        .gesture(DragGesture(minimumDistance: 40).onEnded { value in
            if value.translation.width < -80, abs(value.translation.height) < 80 {
                nextItem()
            }
        })
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
        .confirmationDialog(
            "Discard this batch's new photos?",
            isPresented: $isConfirmingDiscard,
            titleVisibility: .visible,
        ) {
            Button("Discard \(photoText)", role: .destructive) {
                model.discardAll()
                finish(kept: false)
            }
            Button("Check the \(itemsText)") { finish(kept: true) }
            Button("Keep shooting", role: .cancel) {}
        } message: {
            Text("They're saved on this iPhone. Check them to create the items, or discard them.")
        }
    }

    private var itemsText: String {
        model.itemCount == 1 ? "item" : "\(model.itemCount) items"
    }

    private var photoText: String {
        model.shots.count == 1 ? "1 photo" : "\(model.shots.count) photos"
    }

    // MARK: Top

    private var topBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Button {
                    if model.shots.isEmpty {
                        finish(kept: false)
                    } else {
                        isConfirmingDiscard = true
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(Typography.headline)
                        .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                        .background(Palette.scrim.color.opacity(0.45), in: Circle())
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("batchCamera.close")
                Spacer()
                Button {
                    finish(kept: true)
                } label: {
                    Text(model.shots.isEmpty ? "Done" : "Done (\(itemsText))")
                        .font(Typography.headline)
                        .foregroundStyle(model.shots.isEmpty ? Palette.onMedia : Palette.onBrand)
                        .padding(.horizontal, Spacing.md)
                        .frame(minHeight: Layout.minimumTapTarget)
                        .background(
                            model.shots.isEmpty
                                ? AnyShapeStyle(Palette.scrim.color.opacity(0.45))
                                : AnyShapeStyle(Palette.brand),
                            in: Capsule(),
                        )
                }
                .disabled(model.shots.isEmpty || isFinishing)
                .accessibilityIdentifier("batchCamera.done")
            }
            BatchCapturePrompt(model: model, notice: notice)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.top, Spacing.xs)
    }

    // MARK: Bottom

    private var blurNotice: some View {
        HStack(spacing: Spacing.sm) {
            Label("That shot looks blurry", systemImage: "drop.triangle.fill")
                .font(Typography.emphasis)
                .foregroundStyle(Palette.warning)
            Spacer(minLength: Spacing.xs)
            Button("Retake") {
                blurryShotID = nil
                model.removeLast()
            }
            .buttonStyle(.listora(.secondary, size: .compact))
            .fixedSize()
            .accessibilityIdentifier("batchCamera.retake")
        }
        .cardStyle(padding: Spacing.sm)
        .padding(.horizontal, Spacing.md)
        .padding(.bottom, Spacing.xs)
    }

    private var bottomBar: some View {
        HStack(alignment: .center) {
            BatchLastShot(shot: model.lastShot) {
                blurryShotID = nil
                model.removeLast()
            }
            .frame(width: 64, height: 64)
            Spacer()
            ShutterButton(
                isReady: !(isTakingPhoto || isFinishing || cameraProblem != nil),
                isTakingPhoto: isTakingPhoto,
                role: .front,
            ) {
                Task { await takePhoto() }
            }
            .accessibilityLabel("Take photo")
            Spacer()
            Button(action: nextItem) {
                VStack(spacing: 2) {
                    Image(systemName: "arrow.right.circle.fill").font(Typography.title3)
                    Text("Next item").font(Typography.label).fixedSize()
                }
                .frame(minWidth: 64, minHeight: 64)
                .contentShape(Rectangle())
                .opacity(model.canStartNextItem ? 1 : 0.4)
            }
            .disabled(!model.canStartNextItem)
            .accessibilityShowsLargeContentViewer()
            .accessibilityHint("The next photo starts a new item")
            .accessibilityIdentifier("batchCamera.nextItem")
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.sm)
        .background(
            LinearGradient(colors: [.clear, Palette.scrim.color.opacity(0.65)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .bottom),
        )
    }

    // MARK: Actions

    private func takePhoto() async {
        isTakingPhoto = true
        notice = nil
        defer { isTakingPhoto = false }
        do {
            let data = try await camera.capture()
            flash()
            Haptics.play(.tap)
            let photo = try await Task.detached(priority: .userInitiated) { try PhotoPreparation.prepare(data) }.value
            try model.add(photo)
            // Blurry shots are kept, and the seller can retake them without stopping.
            if photo.looksBlurry {
                Haptics.play(.warning)
                blurryShotID = model.lastShot?.id
            } else {
                blurryShotID = nil
            }
        } catch DraftStoreError.tooManyPhotos {
            Haptics.play(.failure)
            notice = "This batch has as many photos as it can take. Tap Done."
        } catch {
            Haptics.play(.failure)
            notice = "That photo couldn't be taken. Try again."
        }
    }

    private func nextItem() {
        guard model.canStartNextItem else { return }
        Haptics.play(.selection)
        blurryShotID = nil
        model.startNextItem()
    }

    private func flash() {
        guard !reduceMotion else { return }
        isFlashing = true
        withAnimation(.easeOut(duration: 0.25)) {
            isFlashing = false
        }
    }

    private func finish(kept: Bool) {
        guard !isFinishing else { return }
        isFinishing = true
        camera.stop()
        if kept, !model.shots.isEmpty {
            Haptics.play(.success)
        }
        Task { await onFinish(kept) }
    }
}
