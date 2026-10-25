// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Core",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "Core", targets: ["Core"]),
    ],
    targets: [
        .target(name: "Core"),
        .testTarget(name: "CoreTests", dependencies: ["Core"], resources: [.copy("Fixtures")]),
    ],
)
