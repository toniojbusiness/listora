// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "DesignSystem",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
    ],
    targets: [
        .target(
            name: "DesignSystem",
            // The wordmark's font (Fraunces, SIL Open Font License) with its license.
            resources: [.copy("Resources/Fonts")],
        ),
        .testTarget(name: "DesignSystemTests", dependencies: ["DesignSystem"]),
    ],
)
