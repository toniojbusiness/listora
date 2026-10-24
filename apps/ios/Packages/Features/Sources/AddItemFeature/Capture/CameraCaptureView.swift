import DesignSystem
import SwiftUI
import UIKit

/// Guided multi-shot capture on the device: front, back, tag, then flaws and details, one tap
/// each. Every shot is prepared right away (upright, at most 2048 px, no GPS) and checked for blur;
/// a blurry shot asks "Retake or keep?" before the guide moves on.
struct CameraCaptureView: View {
    /// Called with the kept shots and their roles; an empty list means the seller cancelled.
    let onFinish: @MainActor ([(PreparedPhoto, PhotoRole)]) async -> Void

    @State private var camera = CameraSession()
    @State private var guide = CaptureGuide()
    @State private var blurryShot: PreparedPhoto?
    @State private var isTakingPhoto = false
    @State private var cameraProblem: String?
    @State private var isConfirmingDiscard = false
    /// A one-off problem with the last shot, shown instead of the step's instruction.
    @State private var notice: String?

    var body: some View {
        ZStack {
            Palette.mediaBackground.color.ignoresSafeArea()
            CameraPreview(session: camera.session)
                .ignoresSafeArea()
                .accessibilityHidden(true)
            VStack(spacing: 0) {
                topBar
                Spacer()
                if let blurryShot {
                    blurWarning(blurryShot)
                }
                bottomBar
            }
            if let cameraProblem {
                cameraProblemView(cameraProblem)
            }
        }
        .foregroundStyle(Palette.onMedia)
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
        }
    }

    private var topBar: some View {
        VStack(spacing: Spacing.sm) {
            HStack {
                Button("Cancel") {
                    if guide.shots.isEmpty {
                        finish(with: [])
                    } else {
                        isConfirmingDiscard = true
                    }
                }
                .frame(minHeight: Layout.minimumTapTarget)
                Spacer()
                Button("Done (\(guide.shots.count))") {
                    finish(with: guide.shots.map { ($0.photo, $0.role) })
                }
                .font(Typography.headline)
                .disabled(guide.shots.isEmpty)
                .frame(minHeight: Layout.minimumTapTarget)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach(CaptureGuide.Step.allCases, id: \.self) { step in
                        stepChip(step)
                    }
                }
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.xs)
        .background(Palette.scrim.color.opacity(0.45))
    }

    private func stepChip(_ step: CaptureGuide.Step) -> some View {
        let count = guide.count(of: step)
        let isCurrent = guide.step == step
        return Button {
            guide.go(to: step)
        } label: {
            HStack(spacing: Spacing.xxs) {
                if count > 0 {
                    Image(systemName: "checkmark.circle.fill")
                }
                Text(count > 1 ? "\(step.title) \(count)" : step.title)
            }
            .font(Typography.caption.weight(.semibold))
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: 32)
            .foregroundStyle(isCurrent ? Palette.onBrand : Palette.onMedia)
            .background(
                isCurrent ? AnyShapeStyle(Palette.brand) : AnyShapeStyle(Palette.scrim.color.opacity(0.4)),
                in: Capsule(),
            )
        }
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    private var bottomBar: some View {
        VStack(spacing: Spacing.sm) {
            Text(notice ?? guide.step.instruction)
                .font(Typography.callout)
                .multilineTextAlignment(.center)
            if guide.step == .details {
                Picker("Shows", selection: $guide.detailRole) {
                    Text("Flaw").tag(PhotoRole.flaw)
                    Text("Detail").tag(PhotoRole.detail)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 240)
            }
            HStack {
                lastShotThumbnail
                    .frame(width: 56, height: 56)
                Spacer()
                shutterButton
                Spacer()
                if guide.step == .details {
                    Color.clear.frame(width: 56, height: 56)
                } else {
                    Button("Skip") { guide.skip() }
                        .font(Typography.headline)
                        .frame(width: 56, height: 56)
                }
            }
        }
        .padding(Spacing.md)
        .background(Palette.scrim.color.opacity(0.45))
    }

    @ViewBuilder
    private var lastShotThumbnail: some View {
        if let last = guide.shots.last, let image = UIImage(data: last.photo.data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    Button {
                        guide.removeLastShot()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(Typography.headline)
                    }
                    .offset(x: Spacing.xs, y: -Spacing.xs)
                    .accessibilityLabel("Remove last photo")
                }
        }
    }

    private var shutterButton: some View {
        Button {
            Task { await takePhoto() }
        } label: {
            ZStack {
                Circle().strokeBorder(Palette.onMedia, lineWidth: 4)
                Circle().fill(Palette.onMedia).padding(8)
                if isTakingPhoto {
                    ProgressView().tint(Palette.mediaBackground.color)
                }
            }
            .frame(width: 76, height: 76)
        }
        .disabled(isTakingPhoto || blurryShot != nil || !guide.canTakeMore || cameraProblem != nil)
        .accessibilityLabel("Take \(guide.role.title.lowercased()) photo")
    }

    private func blurWarning(_ shot: PreparedPhoto) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Label("This shot looks blurry", systemImage: "drop.triangle.fill")
                .font(Typography.headline)
                .foregroundStyle(Palette.warning)
            Text("Hold steady and take it again, or keep it if the details are clear.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
            HStack(spacing: Spacing.sm) {
                Button("Retake") { blurryShot = nil }
                    .buttonStyle(.listoraPrimary)
                Button("Keep it") {
                    guide.accept(shot)
                    blurryShot = nil
                }
                .buttonStyle(.listoraSecondary)
            }
        }
        .cardStyle()
        .padding(Spacing.md)
    }

    private func cameraProblemView(_ message: String) -> some View {
        EmptyStateView(
            systemImage: "camera.badge.ellipsis",
            title: "No camera",
            message: message,
            action: .init("Close") { finish(with: guide.shots.map { ($0.photo, $0.role) }) },
        )
    }

    private func takePhoto() async {
        isTakingPhoto = true
        notice = nil
        defer { isTakingPhoto = false }
        do {
            let data = try await camera.capture()
            let photo = try await Task.detached(priority: .userInitiated) { try PhotoPreparation.prepare(data) }.value
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if photo.looksBlurry {
                blurryShot = photo
            } else {
                guide.accept(photo)
            }
        } catch {
            notice = "That photo couldn't be taken. Try again."
        }
    }

    private func finish(with shots: [(PreparedPhoto, PhotoRole)]) {
        camera.stop()
        Task { await onFinish(shots) }
    }
}
