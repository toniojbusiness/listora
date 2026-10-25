// swift-tools-version: 6.2
import PackageDescription

/// One library per feature. A feature depends on Core, DesignSystem, and (when it talks to the API)
/// APIClient, never on another feature; AppFeature composes them into the tab shell.
let package = Package(
    name: "Features",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AppFeature", targets: ["AppFeature"]),
        .library(name: "InventoryFeature", targets: ["InventoryFeature"]),
        .library(name: "SalesFeature", targets: ["SalesFeature"]),
        .library(name: "AddItemFeature", targets: ["AddItemFeature"]),
        .library(name: "ReviewFeature", targets: ["ReviewFeature"]),
        .library(name: "TasksFeature", targets: ["TasksFeature"]),
        .library(name: "SettingsFeature", targets: ["SettingsFeature"]),
        .library(name: "MarketplacesFeature", targets: ["MarketplacesFeature"]),
        .library(name: "TagReadingFeature", targets: ["TagReadingFeature"]),
        .library(name: "ShareLinkFeature", targets: ["ShareLinkFeature"]),
    ],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../DesignSystem"),
        .package(path: "../APIClient"),
        // The generated contract types (ListoraAPI); the package identity of a local path is its
        // last path component.
        .package(path: "../../../../packages/api-contract/swift"),
        .package(url: "https://github.com/groue/GRDB.swift", from: "7.11.1"),
    ],
    targets: [
        .target(
            name: "AppFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                "InventoryFeature",
                "SalesFeature",
                "AddItemFeature",
                "ReviewFeature",
                "TasksFeature",
                "SettingsFeature",
                "MarketplacesFeature",
                "TagReadingFeature",
            ],
        ),
        .target(
            name: "InventoryFeature",
            dependencies: ["Core", "DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(
            name: "SalesFeature",
            dependencies: ["Core", "DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(
            name: "AddItemFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
        ),
        .target(
            name: "ReviewFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
            resources: [.copy("Resources/vocabulary.json")],
        ),
        .target(
            name: "TasksFeature",
            dependencies: ["DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(name: "SettingsFeature", dependencies: ["Core", "DesignSystem", "APIClient"]),
        .target(
            name: "MarketplacesFeature",
            dependencies: ["DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(name: "TagReadingFeature", dependencies: ["Core"]),
        // The Share Extension's UI; the app target does not link it.
        .target(
            name: "ShareLinkFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
        .testTarget(name: "AppFeatureTests", dependencies: ["AppFeature", "Core", "APIClient"]),
        .testTarget(
            name: "InventoryFeatureTests",
            dependencies: ["InventoryFeature", "Core", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "SalesFeatureTests",
            dependencies: ["SalesFeature", "Core", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "AddItemFeatureTests",
            dependencies: [
                "AddItemFeature",
                "Core",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            resources: [.copy("Fixtures")],
        ),
        .testTarget(
            name: "ReviewFeatureTests",
            dependencies: [
                "ReviewFeature",
                "Core",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
        .testTarget(
            name: "TasksFeatureTests",
            dependencies: ["TasksFeature", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(name: "SettingsFeatureTests", dependencies: ["SettingsFeature", "Core", "APIClient"]),
        .testTarget(
            name: "MarketplacesFeatureTests",
            dependencies: ["MarketplacesFeature", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "TagReadingFeatureTests",
            dependencies: ["TagReadingFeature", "Core"],
            resources: [.copy("Fixtures")],
        ),
        .testTarget(
            name: "ShareLinkFeatureTests",
            dependencies: [
                "ShareLinkFeature",
                "Core",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
    ],
)
