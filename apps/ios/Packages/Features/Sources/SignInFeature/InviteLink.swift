import Foundation

/// Invite codes and the app's invite link, `listora://invite/<code>`, from the message an inviter
/// shares (docs/features/invites.md).
public enum InviteLink {
    /// An invite code has 16 letters and digits; case, spaces, and dashes do not matter.
    public static let codeLength = 16

    /// Whether `text` has a whole code's letters and digits; the server has the last word.
    public static func isCode(_ text: String) -> Bool {
        text.filter { !$0.isWhitespace && $0 != "-" }.count == codeLength
            && text.allSatisfy { $0.isWhitespace || $0 == "-" || ($0.isASCII && ($0.isLetter || $0.isNumber)) }
    }

    /// The invite code in `url`, or nil when it is not an invite link.
    public static func code(in url: URL) -> String? {
        guard url.scheme?.lowercased() == "listora", url.host()?.lowercased() == "invite" else { return nil }
        let code = url.pathComponents.dropFirst().first ?? ""
        return isCode(code) ? code : nil
    }
}
