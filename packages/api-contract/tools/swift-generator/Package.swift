// swift-tools-version: 6.0
// Pins the exact swift-openapi-generator that produces ../../swift/Sources/ListoraAPI/Generated.
// Package.resolved pins every transitive dependency, so regeneration is reproducible.
// Run through `npm run contract:generate`; do not build this package by hand.
import PackageDescription

let package = Package(
    name: "ListoraContractGenerator",
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.14.2"),
    ]
)
