# Listora iOS app (placeholder)

The native Swift 6 / SwiftUI iPhone app lives here. Plan task **T-02** creates it: an XcodeGen
`project.yml` (no hand-edited `.pbxproj`), the SwiftUI app with a Share Extension placeholder,
local Swift packages (Core, DesignSystem, APIClient, Features/\*), SwiftLint/SwiftFormat, unit
and UI test targets, per-environment xcconfig files, `make ios-test`, and the macOS CI job.

This directory is not an npm workspace. See [docs/architecture.md](../../docs/architecture.md).
