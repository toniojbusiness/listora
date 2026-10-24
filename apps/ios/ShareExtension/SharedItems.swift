import Core
import Foundation
import UniformTypeIdentifiers

/// Reads the URLs, text, and title out of the share sheet's items. Item providers are read on
/// their own queues, and only plain values cross back.
struct SharedItems: @unchecked Sendable {
    /// The extension items are only read, never changed, after the share sheet hands them over.
    private let items: [NSExtensionItem]

    init(_ items: [NSExtensionItem]) {
        self.items = items
    }

    func load() async -> SharedContent {
        var content = SharedContent()
        var texts: [String] = []
        for item in items {
            if content.title == nil, let title = item.attributedTitle?.string, !title.isEmpty {
                content.title = title
            }
            if let text = item.attributedContentText?.string, !text.isEmpty {
                texts.append(text)
            }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = await Self.loadURL(provider)
                {
                    content.urls.append(url)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = await Self.loadText(provider)
                {
                    texts.append(text)
                }
            }
        }
        content.text = texts.isEmpty ? nil : texts.joined(separator: "\n")
        return content
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { value, _ in
                continuation.resume(returning: value as? URL)
            }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { value, _ in
                continuation.resume(returning: value as? String)
            }
        }
    }
}
