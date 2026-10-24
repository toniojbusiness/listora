// swift-tools-version: 6.0
// ListoraAPI: the Swift client for the Listora API, generated from ../openapi.yaml.
// The iOS app depends on this package by local path; see ../README.md.
import PackageDescription

let package = Package(
    name: "ListoraAPI",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ListoraAPI", targets: ["ListoraAPI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.13.3"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.4.0"),
    ],
    targets: [
        // Sources/ListoraAPI/Generated is written by `npm run contract:generate`; never edit it.
        .target(
            name: "ListoraAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
        .testTarget(
            name: "ListoraAPITests",
            dependencies: ["ListoraAPI"]
        ),
    ]
)
