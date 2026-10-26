import Foundation
import Security

/// This installation of the app, as Listora's server knows it (`registerDevice`): an id the app
/// makes once and keeps in its Keychain, so the device that linked a marketplace is the one
/// that runs that marketplace's work (docs/features/phone-execution.md).
public enum Installation {
    private static let service = "com.listora.app.installation"
    private static let account = "installation-id"

    /// The installation id, made on first use.
    public static func id() -> String {
        if let stored = read() {
            return stored
        }
        let made = UUID().uuidString.lowercased()
        write(made)
        return read() ?? made
    }

    private static func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ id: String) {
        var item = baseQuery
        item[kSecValueData as String] = Data(id.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// Why the app runs the marketplace work waiting for this phone now.
public enum PhoneWorkReason: String, Sendable {
    /// The app came to the foreground.
    case opened
    /// The seller just linked a marketplace or changed a listing: its work waits now.
    case userAction
    /// A push notification arrived or was tapped (a sale whose delists run here).
    case push
    /// Background app refresh.
    case backgroundRefresh
    /// The overnight run while the phone charges.
    case processing
}

extension Notification.Name {
    /// Posted on the main actor each time the phone finished a run of marketplace work: the
    /// screens that show where marketplaces run, and what waits there, read it again.
    public static let phoneWorkFinished = Notification.Name("ListoraPhoneWorkFinished")
}

/// Asks the app to run the marketplace work waiting for this phone; features that queue such
/// work (linking, listing changes) call it so the phone takes the work at once.
@MainActor
public protocol PhoneWorkTrigger: AnyObject {
    func runPhoneWork(_ reason: PhoneWorkReason)
    /// Makes sure Listora knows this phone (`registerDevice`), before the seller links a
    /// marketplace from it; returns once it does, or once that failed (linking then says why).
    func prepareForWork() async
}

extension PhoneWorkTrigger {
    public func prepareForWork() async {}
}
