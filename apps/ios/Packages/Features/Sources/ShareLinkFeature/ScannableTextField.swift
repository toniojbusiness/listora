import DesignSystem
import SwiftUI
import UIKit

/// A search field with the system's Scan Text button, which reads text into it from the camera
/// with Live Text, for scanning the SKU printed on an item's label. The system camera UI does
/// the scanning, so the extension needs no camera code or permission. Devices without Live Text
/// show no button.
struct ScannableTextField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let accessibilityIdentifier: String

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = placeholder
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(Palette.textPrimary.color)
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .search
        field.clearButtonMode = .whileEditing
        field.accessibilityIdentifier = accessibilityIdentifier
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)

        if Self.canScan(with: field) {
            // The system's own "Scan Text" button, with its title and icon.
            let button = UIButton(primaryAction: UIAction.captureTextFromCamera(responder: field, identifier: nil))
            field.rightView = button
            field.rightViewMode = .always
        }
        return field
    }

    /// Whether this device can read text from the camera into a text field.
    @MainActor
    static var isScanningAvailable: Bool {
        canScan(with: UITextField())
    }

    private static func canScan(with field: UITextField) -> Bool {
        field.canPerformAction(#selector(UIResponder.captureTextFromCamera(_:)), withSender: nil)
    }

    func updateUIView(_ field: UITextField, context _: Context) {
        if field.text != text {
            field.text = text
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        private let text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        @objc
        func changed(_ field: UITextField) {
            text.wrappedValue = field.text ?? ""
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return true
        }

        /// Scanned text arrives through `insertText`, which skips `editingChanged`.
        func textFieldDidChangeSelection(_ field: UITextField) {
            if field.text ?? "" != text.wrappedValue {
                text.wrappedValue = field.text ?? ""
            }
        }
    }
}
