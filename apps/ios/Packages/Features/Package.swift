// swift-tools-version: 6.2
import PackageDescription

/// One library per feature. A feature depends on Core, DesignSystem, and (when it talks to the API)
/// APIClient, never on another feature; AppFeature composes them into the tab shell.
let package = Package(
    name: "Features",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AppFeature", targets: ["AppFeature"]),
        .library(name: "TodayFeature", targets: ["TodayFeature"]),
        .library(name: "InventoryFeature", targets: ["InventoryFeature"]),
        .library(name: "SalesFeature", targets: ["SalesFeature"]),
        .library(name: "AddItemFeature", targets: ["AddItemFeature"]),
        .library(name: "ReviewFeature", targets: ["ReviewFeature"]),
        .library(name: "TasksFeature", targets: ["TasksFeature"]),
        .library(name: "SettingsFeature", targets: ["SettingsFeature"]),
        .library(name: "SignInFeature", targets: ["SignInFeature"]),
        .library(name: "MarketplacesFeature", targets: ["MarketplacesFeature"]),
        .library(name: "TagReadingFeature", targets: ["TagReadingFeature"]),
        .library(name: "VoiceInputFeature", targets: ["VoiceInputFeature"]),
        .library(name: "PhotoSignalsFeature", targets: ["PhotoSignalsFeature"]),
        .library(name: "ShareLinkFeature", targets: ["ShareLinkFeature"]),
        .library(name: "MarketplaceLinkingFeature", targets: ["MarketplaceLinkingFeature"]),
        .library(name: "PhoneExecutionFeature", targets: ["PhoneExecutionFeature"]),
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
                "TodayFeature",
                "InventoryFeature",
                "SalesFeature",
                "AddItemFeature",
                "ReviewFeature",
                "TasksFeature",
                "SettingsFeature",
                "SignInFeature",
                "MarketplacesFeature",
                "TagReadingFeature",
                "MarketplaceLinkingFeature",
                "PhoneExecutionFeature",
                "VoiceInputFeature",
                "PhotoSignalsFeature",
            ],
        ),
        .target(
            name: "TodayFeature",
            dependencies: ["Core", "DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
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
        .target(
            name: "SettingsFeature",
            dependencies: ["Core", "DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        // The welcome and sign-in screens, the app's root while nobody is signed in.
        .target(
            name: "SignInFeature",
            dependencies: ["DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(
            name: "MarketplacesFeature",
            dependencies: ["Core", "DesignSystem", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .target(name: "TagReadingFeature", dependencies: ["Core"]),
        .target(name: "VoiceInputFeature", dependencies: ["Core"]),
        .target(name: "PhotoSignalsFeature", dependencies: ["Core"]),
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
        // Link accounts: sign in on a marketplace's own page and hand Listora its session.
        .target(
            name: "MarketplaceLinkingFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
        // On-phone execution: the phone runtime (bundled from packages/automation) runs the
        // marketplace work Listora hands this phone, in the seller's own session.
        .target(
            name: "PhoneExecutionFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
            resources: [.copy("Resources/phone-runtime.js")],
        ),
        .testTarget(name: "AppFeatureTests", dependencies: ["AppFeature", "Core", "APIClient", "SignInFeature"]),
        .testTarget(
            name: "TodayFeatureTests",
            dependencies: ["TodayFeature", "Core", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
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
        .testTarget(
            name: "SettingsFeatureTests",
            dependencies: ["SettingsFeature", "Core", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "SignInFeatureTests",
            dependencies: ["SignInFeature", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "MarketplacesFeatureTests",
            dependencies: ["MarketplacesFeature", "Core", "APIClient", .product(name: "ListoraAPI", package: "swift")],
        ),
        .testTarget(
            name: "TagReadingFeatureTests",
            dependencies: ["TagReadingFeature", "Core"],
            resources: [.copy("Fixtures")],
        ),
        .testTarget(name: "VoiceInputFeatureTests", dependencies: ["VoiceInputFeature", "Core"]),
        .testTarget(
            name: "PhotoSignalsFeatureTests",
            dependencies: ["PhotoSignalsFeature", "Core"],
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
        .testTarget(
            name: "MarketplaceLinkingFeatureTests",
            dependencies: [
                "MarketplaceLinkingFeature",
                "Core",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
        .testTarget(
            name: "PhoneExecutionFeatureTests",
            dependencies: [
                "PhoneExecutionFeature",
                "Core",
                "APIClient",
                .product(name: "ListoraAPI", package: "swift"),
            ],
        ),
    ],
)
