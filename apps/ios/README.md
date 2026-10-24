# Listora iOS app

The native iPhone app: Swift 6 (strict concurrency), SwiftUI, iOS 18 and later. It is not an
npm workspace. Read [docs/architecture.md](../../docs/architecture.md) first.

## Prerequisites

- Xcode 26.3 with the iPhone 17 simulator (Xcode > Settings > Components installs the iOS
  runtime). The tests reuse that simulator and never create one.
- XcodeGen, SwiftLint, and SwiftFormat from Homebrew:

  ```sh
  brew install xcodegen swiftlint swiftformat
  ```

  The `make` targets stop with this hint when a tool is missing.

## Commands

Run these from the repository root.

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `make ios-generate` | Generate `apps/ios/Listora.xcodeproj` from `project.yml`       |
| `make ios-open`     | Generate the project and open it in Xcode                      |
| `make ios-build`    | Build the app, Share Extension, and packages for the simulator |
| `make ios-test`     | Run package, unit, and UI tests on the iPhone 17 simulator     |
| `make ios-lint`     | SwiftLint (strict) and the SwiftFormat check                   |
| `make ios-format`   | Rewrite Swift files with SwiftFormat and apply SwiftLint fixes |
| `make ios-clean`    | Delete the generated project and `.build/ios`                  |

`make ios-test` writes DerivedData, SwiftPM caches, and the result bundle
(`.build/ios/Test.xcresult`) to `.build/ios` in this checkout, never to `~/Library`. To use a
different simulator, pass its name: `make ios-test IOS_SIMULATOR='iPhone 17 Pro'`.

## The Xcode project

`project.yml` is the only source of the Xcode project. XcodeGen writes `Listora.xcodeproj` and
the Info.plist files in `Generated/`; both are gitignored. Never edit the generated project:
change `project.yml` and run `make ios-generate`. New Swift files in an existing folder need no
project change, because targets include their whole folder.

| Target           | Type          | Contents                                                    |
| ---------------- | ------------- | ----------------------------------------------------------- |
| `Listora`        | App           | `Listora/`: the `@main` entry point; links `AppFeature`     |
| `ShareExtension` | App extension | `ShareExtension/`: placeholder share sheet (T-22 builds it) |
| `ListoraTests`   | Unit tests    | `ListoraTests/`: run inside the app against its real bundle |
| `ListoraUITests` | UI tests      | `ListoraUITests/`: drive the app on the simulator           |

The `Listora` scheme runs every test target, including each package's tests.

## Modules

Code lives in local Swift packages under `Packages/`. The app target only composes them.

```text
Packages/
  Core/          Models and utilities with no UI: AppConfiguration, AppEnvironment, AppVersion
  DesignSystem/  Palette (light and dark colors), Typography, Spacing, Radius, components
  APIClient/     Listora API client (placeholder until T-03 generates it from OpenAPI)
  Features/      One library per feature:
    AppFeature        Root tab shell and AppDependencies (composes the features)
    InventoryFeature  Inventory tab
    AddItemFeature    Add Item tab
    TasksFeature      Tasks tab
    SettingsFeature   Settings tab
```

Dependency rules:

- `Core`, `DesignSystem`, and `APIClient` do not depend on each other or on any feature.
- A feature depends on `Core`, `DesignSystem`, and (when it talks to the API) `APIClient`,
  never on another feature. `AppFeature` is the only module that imports features.
- Add a feature as a new target and library product in `Packages/Features/Package.swift`, and
  its tests as a test target there. List new test targets in the scheme in `project.yml`.
- Views use `Palette`, `Typography`, and `Spacing`, not raw colors, fonts, or numbers.
  `PaletteTests` checks that every text color meets WCAG AA contrast on every background in
  both light and dark mode.
- Tests use Swift Testing (`import Testing`); UI tests use XCTest.

## Environments

Each build configuration reads one xcconfig file in `Config/`, and `AppConfiguration` reads the
values from Info.plist at launch. A missing or invalid value stops the app at launch with an
error that names the key.

| Configuration     | xcconfig                  | `API_BASE_URL`                      | Bundle id suffix |
| ----------------- | ------------------------- | ----------------------------------- | ---------------- |
| `Dev-Debug`       | `Config/Dev.xcconfig`     | `http://127.0.0.1:3000` (local API) | `.dev`           |
| `Staging-Release` | `Config/Staging.xcconfig` | placeholder `.invalid` host         | `.staging`       |
| `Prod-Release`    | `Config/Prod.xcconfig`    | placeholder `.invalid` host         | none             |

- Run and test use `Dev-Debug`; archive uses `Prod-Release`. The build type is part of each
  name because Xcode gives Swift packages debug settings only for configurations whose name
  contains "Debug".
- Dev uses plain HTTP so the simulator can reach `npm run dev:api` on this Mac. Staging and
  Prod must use HTTPS; `AppConfiguration` rejects anything else.
- The Staging and Prod hosts end in `.invalid` and never resolve. The real domains arrive with
  the AWS accounts (gate G-AWS, T-30).
- To point Dev at a different port or host (for example a LAN address for a physical device),
  copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored) and set
  `API_BASE_URL` there.
- No configuration value is a secret. Never put credentials in an xcconfig file.
