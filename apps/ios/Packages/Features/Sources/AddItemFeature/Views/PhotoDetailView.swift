import DesignSystem
import SwiftUI

/// One photo of a draft, large: set its role, crop it, make it the cover, or remove it.
struct PhotoDetailView: View {
    let photo: DraftPhotoRecord
    let model: AddItemModel

    @State private var isCropping = false
    @State private var isConfirmingDelete = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    PhotoThumbnail(url: model.store.fileURL(for: photo), pointSize: 420, contentMode: .fit)
                        .aspectRatio(CGFloat(photo.width) / CGFloat(max(photo.height, 1)), contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                        .frame(maxWidth: .infinity)
                    if photo.looksBlurry {
                        Label(
                            "This photo looks blurry. A sharper one helps buyers and the item details.",
                            systemImage: "drop.triangle.fill",
                        )
                        .font(Typography.callout)
                        .foregroundStyle(Palette.warning)
                    }
                    rolePicker
                    uploadStatus
                    actions
                }
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .navigationTitle(photo.position == 0 ? "Cover photo" : "Photo \(photo.position + 1)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("photo.done")
                }
            }
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
            }
        }
    }

    private var rolePicker: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("What it shows")
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
            Picker("Role", selection: Binding(get: { photo.role }, set: { model.setRole($0, of: photo.id) })) {
                ForEach(PhotoRole.allCases, id: \.self) { role in
                    Text(role.title).tag(role)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("photo.role")
            if photo.role == .tag {
                Text("Listora reads the brand, size, and materials from tag photos on this iPhone.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
    }

    private var uploadStatus: some View {
        let status = PhotoUploadStatus(
            photo: photo,
            isTransferring: model.activity.transferring.contains(photo.id),
            isSignedIn: model.activity.isSignedIn,
        )
        return HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Image(systemName: status.systemImage)
                .foregroundStyle(status == .uploaded ? Palette.success : Palette.textSecondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(status.label)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("photo.uploadStatus")
                if case let .failed(message) = status {
                    Text(message)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if case .failed = status {
                Button("Retry") { model.retry(photo.draftID) }
                    .font(Typography.headline)
                    .foregroundStyle(Palette.brand)
                    .frame(minHeight: Layout.minimumTapTarget)
            }
        }
        .cardStyle()
    }

    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Button {
                    isCropping = true
                } label: {
                    Label("Crop", systemImage: "crop")
                }
                .accessibilityIdentifier("photo.crop")
                Button {
                    model.movePhoto(photo.id, to: 0)
                } label: {
                    Label("Make cover", systemImage: "star")
                }
                .disabled(photo.position == 0)
                .accessibilityIdentifier("photo.makeCover")
            }
            .buttonStyle(.listoraSecondary)
            Button(role: .destructive) {
                isConfirmingDelete = true
            } label: {
                Label("Remove photo", systemImage: "trash")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.danger)
                    .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
            }
            .accessibilityIdentifier("photo.delete")
        }
    }
}
