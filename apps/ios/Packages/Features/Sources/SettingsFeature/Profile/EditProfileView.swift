import DesignSystem
import PhotosUI
import SwiftUI

/// Settings > the profile: the photo (chosen from the library, kept on this iPhone), the name and
/// business name (saved on the server with Save), and the email the seller signs in with, which
/// only reads.
struct EditProfileView: View {
    @Bindable var model: ProfileModel
    @State private var pickedPhoto: PhotosPickerItem?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                photoSection
                VStack(alignment: .leading, spacing: Spacing.md) {
                    ListoraTextField("Your name", hint: "How Listora greets you.") {
                        TextField("Your name", text: $model.draftName, prompt: prompt("Sam Rivera"))
                            .textContentType(.name)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.next)
                            .accessibilityIdentifier("profile.name")
                    }
                    ListoraTextField("Business name", hint: "The shop or brand you sell as.") {
                        TextField(
                            "Business name",
                            text: $model.draftBusinessName,
                            prompt: prompt("Second Spin Vintage"),
                        )
                        .textContentType(.organizationName)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .accessibilityIdentifier("profile.businessName")
                    }
                    email
                }
                if let error = model.saveError {
                    Banner("Your profile wasn't saved", message: error, tone: .failed, identifier: "profile.saveError")
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        if await model.save() {
                            dismiss()
                        }
                    }
                }
                .disabled(!model.hasChanges || model.isSaving)
                .accessibilityIdentifier("profile.save")
            }
        }
        .onAppear { model.beginEditing() }
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    await model.setPhoto(data)
                }
                pickedPhoto = nil
            }
        }
    }

    private var photoSection: some View {
        let pickTitle = model.photo == nil ? "Add photo" : "Change photo"
        return VStack(spacing: Spacing.sm) {
            Avatar(initials: model.initials, image: model.photo, size: .large)
            HStack(spacing: Spacing.sm) {
                PhotosPicker(selection: $pickedPhoto, matching: .images, photoLibrary: .shared()) {
                    Label(pickTitle, systemImage: "photo")
                }
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityIdentifier("profile.choosePhoto")
                if model.photo != nil {
                    Button("Remove", role: .destructive) { model.removePhoto() }
                        .buttonStyle(.listora(.destructiveText, size: .compact))
                        .accessibilityIdentifier("profile.removePhoto")
                }
            }
            Text("Your photo stays on this iPhone.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            if let problem = model.photoProblem {
                Text(problem)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("profile.photoProblem")
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// The email signs in, so it only reads here.
    private var email: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Email")
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textPrimary)
            Text(model.email ?? "No email")
                .font(Typography.body)
                .foregroundStyle(Palette.textSecondary)
                .textSelection(.enabled)
            Text("You sign in with this email.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profile.email")
    }

    private func prompt(_ example: String) -> Text {
        Text(example).foregroundStyle(Palette.textSecondary)
    }
}
