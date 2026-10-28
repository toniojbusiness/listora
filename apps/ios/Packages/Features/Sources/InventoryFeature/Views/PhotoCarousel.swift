import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's photos, swipeable, cover first, on the item's tag (the item screen hangs it). Each
/// shows its thumbnail (already cached by the inventory) until its listing size arrives, and all
/// of them are fetched when the screen opens, so a swipe finds the next photo ready.
struct PhotoCarousel: View {
    let photos: [Components.Schemas.Photo]

    var body: some View {
        if photos.isEmpty {
            PhotoView(url: nil, cornerRadius: Radius.small)
                .frame(height: 200)
        } else {
            TabView {
                ForEach(photos, id: \.id) { photo in
                    PhotoView(
                        url: photo.urls?.listing ?? photo.urls?.thumbnail,
                        preview: photo.urls?.thumbnail,
                        cornerRadius: Radius.small,
                    )
                    .accessibilityLabel("Photo \(photo.position + 1) of \(photos.count)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
            .frame(height: 240)
            .task(id: photos.map(\.id)) {
                RemoteImageLoader.shared.prefetch(photos.compactMap { $0.urls.flatMap { URL(string: $0.listing) } })
            }
        }
    }
}
