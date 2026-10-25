import Core
import DesignSystem
import SwiftUI

/// One photo of a draft, large: set what it shows, see what Listora read on a tag, crop it, make it
/// the cover, or remove it.
struct PhotoDetailView: View {
    let photo: DraftPhotoRecord
    let model: AddItemModel

    @State private var isCropping = false
    @State private var isConfirmingDelete = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    PhotoThumbnail(url: model.store.fileURL(for: photo), pointSize: 320, contentMode: .fit)
                        .aspectRatio(CGFloat(photo.width) / CGFloat(max(photo.height, 1)), contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                        .frame(maxWidth: .infinity, maxHeight: 320)
                        .accessibilityLabel("\(photo.role.title) photo")
                    if photo.looksBlurry {
                        Banner(
                            "This photo looks blurry",
                            message: "A sharper photo helps buyers, and helps Listora read the details.",
                            tone: .actionNeeded,
                            systemImage: "drop.triangle.fill",
                        )
                    }
                    rolePicker
                    if photo.role == .tag {
                        TagReadingCard(photo: photo)
                    }
                    uploadStatus
                }
                .padding(Spacing.md)
                .motion(value: photo.role)
            }
            .background(Palette.background)
            .navigationTitle(photo.position == 0 ? "Cover photo" : "Photo \(photo.position + 1)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Remove photo", systemImage: "trash", role: .destructive) {
                        isConfirmingDelete = true
                    }
                    .tint(Palette.danger.color)
                    .accessibilityIdentifier("photo.delete")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("photo.done")
                }
            }
            .bottomActionBar { actions }
            .fullScreenCover(isPresented: $isCropping) {
                CropView(
                    url: model.store.fileURL(for: photo),
                    aspectRatio: CGFloat(photo.width) / CGFloat(max(photo.height, 1)),
                ) { rect in
                    isCropping = false
                    guard let rect else { return }
                    dismiss()
                    await model.crop(photo, to: rect)
                }
            }
            .confirmationDialog("Remove this photo?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    model.deletePhoto(photo.id)
                    dismiss()
                }
            } message: {
                Text("It's removed from this draft, on this iPhone and in Listora.")
            }
        }
    }

    private var rolePicker: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("What it shows")
            FlowLayout {
                ForEach(PhotoRole.allCases, id: \.self) { role in
                    ChoiceChip(role.title, systemImage: role.systemImage, isSelected: photo.role == role) {
                        model.setRole(role, of: photo.id)
                    }
                    .accessibilityIdentifier("photo.role.\(role.rawValue)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("What it shows")
            .accessibilityIdentifier("photo.role")
        }
    }

    private var uploadStatus: some View {
        let status = PhotoUploadStatus(
            photo: photo,
            isTransferring: model.activity.transferring.contains(photo.id),
            isSignedIn: model.activity.isSignedIn,
        )
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Upload")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    StatusBadge(status.label, tone: status.tone)
                        .accessibilityIdentifier("photo.uploadStatus")
                    Spacer(minLength: 0)
                }
                if case let .failed(message) = status {
                    Text(message)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textPrimary)
                    Button("Retry") { model.retry(photo.draftID) }
                        .buttonStyle(.listora(.secondary, size: .compact))
                } else {
                    Text(status.explanation)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            .cardStyle(.outlined)
        }
    }

    private var actions: some View {
        AdaptiveStack { actionButtons }
    }

    @ViewBuilder
    private var actionButtons: some View {
        Button {
            isCropping = true
        } label: {
            Label("Crop", systemImage: "crop")
        }
        .buttonStyle(.listoraSecondary)
        .accessibilityIdentifier("photo.crop")
        Button {
            Motion.perform { model.movePhoto(photo.id, to: 0) }
        } label: {
            Label(photo.position == 0 ? "This is the cover" : "Make cover", systemImage: "star")
        }
        .buttonStyle(.listoraSecondary)
        .disabled(photo.position == 0)
        .accessibilityIdentifier("photo.makeCover")
    }
}

extension PhotoRole {
    var systemImage: String {
        switch self {
        case .front: "tshirt"
        case .back: "arrow.uturn.left"
        case .tag: "tag"
        case .flaw: "exclamationmark.magnifyingglass"
        case .detail: "sparkle.magnifyingglass"
        }
    }
}

extension PhotoUploadStatus {
    /// One sentence about what happens next.
    var explanation: String {
        switch self {
        case .waiting: "Waiting its turn. Photos upload one after another."
        case .readingTag: "Reading the tag on this iPhone first."
        case .uploading: "Uploading now. It keeps going if you leave the app."
        case .uploaded: "Listora has this photo with its current role."
        case let .retrying(attempt, maxAttempts):
            "The last try didn't work. Listora tries again on its own (\(attempt) of \(maxAttempts))."
        case .waitingForSignIn: "Saved on this iPhone. It uploads after you sign in."
        case .failed: ""
        }
    }
}

/// What on-device tag reading found on a tag photo: the raw lines and barcodes, as read. Listora
/// sends them with the photo; the item's details come from the review, not from this card.
struct TagReadingCard: View {
    let photo: DraftPhotoRecord

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("What Listora read")
                .accessibilityIdentifier("tagReading.title")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                content
            }
            .cardStyle(.outlined)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tagReading.card")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch photo.tagReadState {
        case .pending, .notNeeded:
            HStack(spacing: Spacing.xs) {
                ProgressView().controlSize(.small)
                Text("Reading the tag on this iPhone...")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tagReading.pending")
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SkeletonBlock(width: 180)
                SkeletonBlock(width: 120)
                SkeletonBlock(width: 150)
            }
        case .failed:
            Label("Listora couldn't read this tag. The photo still uploads.", systemImage: "text.badge.xmark")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textPrimary)
        case .done:
            let reads = photo.tagReads
            let lines = reads?.ocrLines ?? []
            let barcodes = reads?.barcodes ?? []
            if lines.isEmpty, barcodes.isEmpty {
                Label(
                    "No text found. A closer, sharper photo of the tag helps.",
                    systemImage: "text.magnifyingglass",
                )
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textPrimary)
            } else {
                if !lines.isEmpty {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        ForEach(Array(lines.prefix(Self.shownLines).enumerated()), id: \.offset) { _, line in
                            Text(line.text)
                                .font(Typography.callout.monospaced())
                                .foregroundStyle(Palette.textPrimary)
                                .textSelection(.enabled)
                        }
                        if lines.count > Self.shownLines {
                            Text("and \(lines.count - Self.shownLines) more lines")
                                .font(Typography.footnote)
                                .foregroundStyle(Palette.textSecondary)
                        }
                    }
                }
                if !barcodes.isEmpty {
                    FlowLayout {
                        ForEach(Array(barcodes.enumerated()), id: \.offset) { _, barcode in
                            Chip("\(Self.name(of: barcode.symbology)) \(barcode.payload)", systemImage: "barcode")
                                .overlay(Capsule().strokeBorder(Palette.separator.color, lineWidth: 1))
                        }
                    }
                }
                Text(
                    "Read on this iPhone and sent with the photo. You check the item's details before "
                        + "anything is listed.",
                )
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
        }
    }

    private static let shownLines = 8

    private static func name(of symbology: String) -> String {
        switch TagBarcode.Symbology(rawValue: symbology) {
        case .ean13: "EAN-13"
        case .ean8: "EAN-8"
        case .upce: "UPC-E"
        case .code128: "Code 128"
        case .qr: "QR"
        case nil: symbology
        }
    }
}
