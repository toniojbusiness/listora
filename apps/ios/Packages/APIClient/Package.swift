// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "APIClient",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "APIClient", targets: ["APIClient"]),
    ],
    targets: [
        .target(name: "APIClient"),
        .testTarget(name: "APIClientTests", dependencies: ["APIClient"]),
    ],
)
