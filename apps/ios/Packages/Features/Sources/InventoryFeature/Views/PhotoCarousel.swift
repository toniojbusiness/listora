import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's photos, swipeable, cover first, on the item's tag (the item screen hangs it).
struct PhotoCarousel: View {
    let photos: [Components.Schemas.Photo]

    var body: some View {
        if photos.isEmpty {
            PhotoView(url: nil, cornerRadius: Radius.small)
                .frame(height: 200)
        } else {
            TabView {
                ForEach(photos, id: \.id) { photo in
                    PhotoView(url: photo.urls?.listing ?? photo.urls?.thumbnail, cornerRadius: Radius.small)
                        .accessibilityLabel("Photo \(photo.position + 1) of \(photos.count)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
            .frame(height: 240)
        }
    }
}
