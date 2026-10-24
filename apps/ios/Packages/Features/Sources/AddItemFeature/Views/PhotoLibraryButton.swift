import DesignSystem
import PhotosUI
import SwiftUI

/// Picks photos from the library with the system photo picker (the simulator's only photo
/// source) and hands their data over in the order chosen.
///
/// In debug builds with `LISTORA_FIXTURE_PHOTOS` set, it imports that folder's JPEGs instead, so
/// UI tests add known photos without driving the system picker.
struct PhotoLibraryButton<Label: View>: View {
    let maxCount: Int
    let fixturePhotosDirectory: URL?
    let onPicked: @MainActor ([Data]) async -> Void
    @ViewBuilder let label: () -> Label

    @State private var selection: [PhotosPickerItem] = []

    var body: some View {
        if let fixturePhotosDirectory {
            Button {
                Task { await onPicked(Self.fixtures(in: fixturePhotosDirectory, maxCount: maxCount)) }
            } label: {
                label()
            }
        } else {
            PhotosPicker(
                selection: $selection,
                maxSelectionCount: max(maxCount, 1),
                selectionBehavior: .ordered,
                matching: .images,
                preferredItemEncoding: .compatible,
            ) {
                label()
            }
            .disabled(maxCount <= 0)
            .onChange(of: selection) { _, items in
                guard !items.isEmpty else { return }
                selection = []
                Task { await onPicked(Self.load(items)) }
            }
        }
    }

    private static func load(_ items: [PhotosPickerItem]) async -> [Data] {
        var images: [Data] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                images.append(data)
            }
        }
        return images
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
