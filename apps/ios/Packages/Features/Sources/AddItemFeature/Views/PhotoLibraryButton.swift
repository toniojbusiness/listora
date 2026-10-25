import DesignSystem
import PhotosUI
import SwiftUI

/// Picks photos from the library with the system photo picker (the simulator's only photo
/// source) and hands their data over in the order chosen.
///
/// A picked photo that cannot be loaded (an iCloud original that does not download) is never
/// dropped silently: nothing is handed over, and `unloaded` is set for the parent to show an
/// ``UnloadedPhotosNotice``, which tries again or goes on with the photos that loaded.
///
/// In debug builds with `LISTORA_FIXTURE_PHOTOS` set, it imports that folder's JPEGs instead, so
/// UI tests add known photos without driving the system picker.
struct PhotoLibraryButton: View {
    let maxCount: Int
    let fixturePhotosDirectory: URL?
    @Binding var unloaded: PickedPhotos<PhotosPickerItem>?
    let onPicked: @MainActor ([Data]) async -> Void
    /// The button's label. Plain values, because the picker's label closure is Sendable.
    let title: String
    let systemImage: String

    @State private var selection: [PhotosPickerItem] = []

    var body: some View {
        if let fixturePhotosDirectory {
            Button {
                Task { await onPicked(Self.fixtures(in: fixturePhotosDirectory, maxCount: maxCount)) }
            } label: {
                Label(title, systemImage: systemImage)
            }
        } else {
            PhotosPicker(
                selection: $selection,
                maxSelectionCount: max(maxCount, 1),
                selectionBehavior: .ordered,
                matching: .images,
                preferredItemEncoding: .compatible,
            ) { [title, systemImage] in
                Label(title, systemImage: systemImage)
            }
            .disabled(maxCount <= 0)
            .onChange(of: selection) { _, items in
                guard !items.isEmpty else { return }
                selection = []
                Task { await load(items) }
            }
        }
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var picked = PickedPhotos(items)
        await picked.loadFromLibrary()
        if picked.unloadedCount == 0 {
            await onPicked(picked.loaded)
        } else {
            unloaded = picked
        }
    }

    private static func fixtures(in directory: URL, maxCount: Int) -> [Data] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension.lowercased() == "jpg" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .prefix(maxCount)
            .compactMap { try? Data(contentsOf: $0) }
    }
}

/// Photos picked in the library, loaded in the order picked. Loading one can fail, and a later
/// ``load(using:)`` tries only the ones that have not loaded.
@MainActor
struct PickedPhotos<Item: Sendable> {
    private let items: [Item]
    private var images: [Data?]

    init(_ items: [Item]) {
        self.items = items
        images = Array(repeating: nil, count: items.count)
    }

    /// The photos that loaded, in the order picked.
    var loaded: [Data] {
        images.compactMap(\.self)
    }

    var unloadedCount: Int {
        images.count { $0 == nil }
    }

    /// What the seller is told about the photos that did not load, if any.
    var problem: String? {
        switch unloadedCount {
        case 0: nil
        case 1: "1 photo could not be loaded from iCloud."
        case let count: "\(count) photos could not be loaded from iCloud."
        }
    }

    mutating func load(using loadData: (Item) async -> Data?) async {
        for index in images.indices where images[index] == nil {
            images[index] = await loadData(items[index])
        }
    }
}

extension PickedPhotos<PhotosPickerItem> {
    mutating func loadFromLibrary() async {
        await load { item in try? await item.loadTransferable(type: Data.self) }
    }
}

/// Says how many picked photos did not load, with Try again and a way to go on with the photos
/// that did.
struct UnloadedPhotosNotice: View {
    @Binding var picked: PickedPhotos<PhotosPickerItem>?
    let onPicked: @MainActor ([Data]) async -> Void

    @State private var isLoading = false

    var body: some View {
        if let picked, let problem = picked.problem {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Label(problem, systemImage: "exclamationmark.icloud")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("photos.unloaded")
                HStack(spacing: Spacing.md) {
                    Button("Try again") {
                        Task { await retry(picked) }
                    }
                    .disabled(isLoading)
                    Button(picked.loaded.isEmpty ? "Dismiss" : "Add the \(picked.loaded.count) that loaded") {
                        self.picked = nil
                        let loaded = picked.loaded
                        if !loaded.isEmpty {
                            Task { await onPicked(loaded) }
                        }
                    }
                    .disabled(isLoading)
                }
                .font(Typography.headline)
                .foregroundStyle(Palette.brand)
                .frame(minHeight: Layout.minimumTapTarget)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func retry(_ current: PickedPhotos<PhotosPickerItem>) async {
        isLoading = true
        defer { isLoading = false }
        var again = current
        await again.loadFromLibrary()
        if again.unloadedCount == 0 {
            picked = nil
            await onPicked(again.loaded)
        } else {
            picked = again
        }
    }
}
