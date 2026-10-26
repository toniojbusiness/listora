import SwiftUI
import Testing
import UIKit
@testable import DesignSystem

@MainActor
struct AvatarTests {
    @Test
    func `initials come from the first name that has letters`() {
        #expect(Avatar.initials(for: ["Sam Rivera", "Second Spin"]) == "SR")
        #expect(Avatar.initials(for: [nil, "second spin vintage"]) == "SS")
        #expect(Avatar.initials(for: ["  ", nil, "sam.rivera@example.com"]) == "S")
        #expect(Avatar.initials(for: ["Zoë"]) == "Z")
        #expect(Avatar.initials(for: [nil, nil]).isEmpty)
    }

    @Test(arguments: [Avatar.Size.toolbar, .row, .large])
    func `is a circle of its size, with initials, a photo, or neither`(size: Avatar.Size) {
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200)).image { context in
            UIColor.gray.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        }
        for avatar in [
            Avatar(initials: "SR", size: size),
            Avatar(initials: "", size: size),
            Avatar(initials: "SR", image: photo, size: size),
        ] {
            let host = UIHostingController(rootView: avatar)
            let fitted = host.sizeThatFits(in: CGSize(width: 400, height: 400))
            #expect(fitted.width == fitted.height)
            #expect(fitted.width >= 32)
        }
    }
}
