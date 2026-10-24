// swift-tools-version: 6.2
import PackageDescription

/// The app's connection to the Listora API: the generated `ListoraAPI` client (from
/// packages/api-contract) over URLSession, the signed-in session's bearer token, and the error model.
let package = Package(
    name: "APIClient",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "APIClient", targets: ["APIClient"]),
    ],
    dependencies: [
        // The package identity of a local path is its last path component.
        .package(path: "../../../../packages/api-contract/swift"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.13.3"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.4.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.4.0"),
    ],
    targets: [
        .target(
            name: "APIClient",
            dependencies: [
                .product(name: "ListoraAPI", package: "swift"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
        ),
        .testTarget(
            name: "APIClientTests",
            dependencies: [
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
        ),
    ],
)
