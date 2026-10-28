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

/// The item as a tag: its photos hang on it, its marketplaces hang on the string below, and once
/// it sells it wears the sold stamp, pressed on when it sold while the screen was open.
struct ItemTag: View {
    let item: Item
    let soldWhileOpen: Bool

    var body: some View {
        HangingTag(railOverhang: nil) {
            PhotoCarousel(photos: item.photos)
                .overlay {
                    if item.isSold, let summary = item.saleSummary {
                        SoldStamp(
                            price: Formatting.money(summary.salePrice),
                            marketplace: summary.soldOn.map { Formatting.marketplaceName($0.id) },
                            lands: soldWhileOpen,
                        )
                    }
                }
        }
    }
}
