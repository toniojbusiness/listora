// swift-tools-version: 6.2
import PackageDescription

/// One library per feature. A feature depends on Core and DesignSystem, never on another
/// feature; AppFeature composes them into the tab shell.
let package = Package(
    name: "Features",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AppFeature", targets: ["AppFeature"]),
        .library(name: "InventoryFeature", targets: ["InventoryFeature"]),
        .library(name: "AddItemFeature", targets: ["AddItemFeature"]),
        .library(name: "TasksFeature", targets: ["TasksFeature"]),
        .library(name: "SettingsFeature", targets: ["SettingsFeature"]),
    ],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../DesignSystem"),
        .package(path: "../APIClient"),
    ],
    targets: [
        .target(
            name: "AppFeature",
            dependencies: [
                "Core",
                "DesignSystem",
                "APIClient",
                "InventoryFeature",
                "AddItemFeature",
                "TasksFeature",
                "SettingsFeature",
            ],
        ),
        .target(name: "InventoryFeature", dependencies: ["DesignSystem"]),
        .target(name: "AddItemFeature", dependencies: ["DesignSystem"]),
        .target(name: "TasksFeature", dependencies: ["DesignSystem"]),
        .target(name: "SettingsFeature", dependencies: ["Core", "DesignSystem"]),
        .testTarget(name: "AppFeatureTests", dependencies: ["AppFeature", "Core"]),
        .testTarget(name: "SettingsFeatureTests", dependencies: ["SettingsFeature", "Core"]),
    ],
)
