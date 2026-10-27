import DesignSystem
import SwiftUI
import UIKit

/// One step of the guided capture in the chip row: its number, or a check once taken, and how many
/// shots it has. The current step is brand filled; tapping a chip goes to that step.
struct CaptureStepChip: View {
    let step: CaptureGuide.Step
    let number: Int
    /// How many shots the step has.
    let taken: Int
    let isCurrent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xxs) {
                Image(systemName: taken > 0 ? "checkmark.circle.fill" : "\(number).circle")
                    .foregroundStyle(iconColor)
                Text(taken > 1 ? "\(step.title) \(taken)" : step.title)
            }
            .font(Typography.emphasis)
            .lineLimit(1)
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: 36)
            .foregroundStyle(isCurrent ? Palette.onBrand : Palette.onMedia)
            .background(
                isCurrent ? AnyShapeStyle(Palette.brand) : AnyShapeStyle(Palette.scrim.color.opacity(0.45)),
                in: Capsule(),
            )
            .frame(minHeight: Layout.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .accessibilityShowsLargeContentViewer()
        .accessibilityLabel(taken > 0 ? "\(step.title), \(taken) taken" : step.title)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("camera.step.\(number)")
    }

    private var iconColor: ColorToken {
        if isCurrent {
            Palette.onBrand
        } else if taken > 0 {
            Palette.brand
        } else {
            Palette.onMedia
        }
    }
}

/// The last shot's thumbnail, with a button that removes it.
struct LastShotThumbnail: View {
    let shot: CaptureGuide.Shot?
    let onRemove: () -> Void

    var body: some View {
        if let shot, let image = UIImage(data: shot.photo.data) {
            let shape = RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Palette.onMedia, lineWidth: 2))
                .overlay(alignment: .topTrailing) {
                    Button(action: onRemove) {
                        Image(systemName: "xmark.circle.fill")
                            .font(Typography.title3)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(Palette.onMedia, Palette.scrim.color.opacity(0.8))
                            .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                            .contentShape(Rectangle())
                    }
                    .offset(x: Spacing.md, y: -Spacing.md)
                    .accessibilityLabel("Remove last photo")
                    .accessibilityIdentifier("camera.removeLast")
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Last photo, \(shot.role.title)")
        }
    }
}

/// The current step's prompt: where it is in the guide, the step, and how to take it.
struct CapturePrompt: View {
    let step: CaptureGuide.Step
    /// What to show under the step: its instruction, or a problem with the last shot.
    let message: String

    var body: some View {
        let steps = CaptureGuide.Step.allCases
        let number = (steps.firstIndex(of: step) ?? 0) + 1
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("Step \(number) of \(steps.count)")
                .font(Typography.label)
                .textCase(.uppercase)
                .foregroundStyle(Palette.brand)
            Text(step.title)
                .font(Typography.title)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("camera.stepTitle")
            Text(message)
                .font(Typography.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("camera.instruction")
        }
        .foregroundStyle(Palette.onMedia)
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Palette.scrim.color.opacity(0.55),
            in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous),
        )
    }
}

/// Asks whether to keep a shot that looks blurry.
struct BlurWarning: View {
    let onRetake: () -> Void
    let onKeep: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Label("This shot looks blurry", systemImage: "drop.triangle.fill")
                .font(Typography.headline)
                .foregroundStyle(Palette.warning)
            Text("Hold steady and take it again, or keep it if the details are clear.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textPrimary)
            AdaptiveStack { buttons }
        }
        .cardStyle()
        .padding(.horizontal, Spacing.md)
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Retake", action: onRetake)
            .buttonStyle(.listoraPrimary)
            .accessibilityIdentifier("camera.retake")
        Button("Keep it", action: onKeep)
            .buttonStyle(.listoraSecondary)
            .accessibilityIdentifier("camera.keep")
    }
}

/// The shutter: a white ring and disc, dimmed while it cannot take a photo, with a spinner while
/// one is being taken.
struct ShutterButton: View {
    let isReady: Bool
    let isTakingPhoto: Bool
    let role: PhotoRole
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(Palette.onMedia, lineWidth: 5)
                Circle()
                    .fill(Palette.onMedia)
                    .padding(isTakingPhoto ? 14 : 9)
                if isTakingPhoto {
                    BrandSpinner(color: Palette.mediaBackground)
                }
            }
            .frame(width: Layout.shutterSize, height: Layout.shutterSize)
            .opacity(isReady || isTakingPhoto ? 1 : 0.4)
            .motion(Motion.snappy, value: isTakingPhoto)
        }
        .buttonStyle(.plain)
        .disabled(!isReady)
        .accessibilityLabel("Take \(role.title.lowercased()) photo")
        .accessibilityIdentifier("camera.shutter")
    }
}
