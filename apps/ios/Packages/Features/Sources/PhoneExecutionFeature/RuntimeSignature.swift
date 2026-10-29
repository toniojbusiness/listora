import CryptoKit
import Foundation

/// Checks the release key's signature of a phone runtime the server hands out
/// (docs/features/phone-execution.md#the-runtimes-signature). CI signs each bundle with Listora's
/// offline Ed25519 release key when it builds the server's image; the server never holds that
/// key. The app runs a runtime it was handed only when the signature verifies with the public
/// key it is built with, so a server or deploy someone else controls can't run code of its own in
/// the seller's marketplace sessions.
struct RuntimeSignature {
    /// The release key's public half (raw, base64), the same as `PHONE_RUNTIME_PUBLIC_KEY` in
    /// `packages/automation/src/phone/signing.ts` (a test there checks they match). Replacing it
    /// means a new app build.
    static let publicKey = "9wBwY9uOMkb8mOLQOO1mOmQ8FQNVqG0te9VoAV4UmQ4="

    static let release = RuntimeSignature(publicKey: Self.publicKey)

    private let key: Curve25519.Signing.PublicKey?

    init(publicKey base64: String) {
        key = Data(base64Encoded: base64).flatMap { try? Curve25519.Signing.PublicKey(rawRepresentation: $0) }
    }

    /// Whether `signature` (base64) is the release key's over this runtime version and digest.
    func verifies(_ signature: String?, runtimeVersion: Int, digest: String) -> Bool {
        guard let key, let signature, let bytes = Data(base64Encoded: signature), bytes.count == 64 else {
            return false
        }
        return key.isValidSignature(bytes, for: Self.message(runtimeVersion: runtimeVersion, digest: digest))
    }

    /// What the release key signs: `listora-phone-runtime\n{version}\n{digest}`.
    static func message(runtimeVersion: Int, digest: String) -> Data {
        Data("listora-phone-runtime\n\(runtimeVersion)\n\(digest)".utf8)
    }
}
