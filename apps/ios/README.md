# Listora iOS app

The native iPhone app: Swift 6 (strict concurrency), SwiftUI, iOS 18 and later. It is not an
npm workspace. Read [docs/architecture.md](../../docs/architecture.md) first.

The app talks to the backend only through the generated `ListoraAPI` Swift package in
`packages/api-contract/swift`; see
[its README](../../packages/api-contract/README.md#using-the-contract).

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

| Command                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `make ios-generate`     | Generate `apps/ios/Listora.xcodeproj` from `project.yml`       |
| `make ios-open`         | Generate the project and open it in Xcode                      |
| `make ios-build`        | Build the app, Share Extension, and packages for the simulator |
| `make ios-test`         | Run package, unit, and UI tests on the iPhone 17 simulator     |
| `make ios-lint`         | SwiftLint (strict) and the SwiftFormat check                   |
| `make ios-format`       | Rewrite Swift files with SwiftFormat and apply SwiftLint fixes |
| `make ios-clean`        | Delete the generated project and `.build/ios`                  |
| `make ios-tag-fixtures` | Re-render the tag-reading test photos (see Tag reading)        |

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
  Core/          Models and utilities with no UI: AppConfiguration, AppEnvironment, AppVersion,
                 and the TagReader protocol with its TagReading model
  DesignSystem/  Palette (light and dark colors), Typography, Spacing, Radius, components
  APIClient/     Listora API client (placeholder until T-03 generates it from OpenAPI)
  Features/      One library per feature:
    AppFeature        Root tab shell and AppDependencies (composes the features)
    InventoryFeature  Inventory tab
    AddItemFeature    Add Item tab
    TasksFeature      Tasks tab
    SettingsFeature   Settings tab
    TagReadingFeature On-device tag reading with Vision (VisionTagReader); no UI
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
- A feature that other features use without UI (such as `TagReadingFeature`) implements a
  protocol from `Core`. `AppDependencies` builds the implementation and the features that need
  it receive the protocol, so no feature imports another.

## Tag reading

`VisionTagReader` (in `TagReadingFeature`) reads photos whose role is `tag`, on the device and
off the main actor. It runs Vision text recognition (accurate, language correction off, Latin
languages only) and barcode detection (EAN-13 including UPC-A, EAN-8, UPC-E, Code 128, QR) on
the upright photo, then a size-tab pass. That pass re-reads the photo in overlapping 3 x 3 tiles,
because the whole-photo pass skips or misreads small isolated sizes such as "M", "8", or "XS".
The result, `TagReading`, holds each line and barcode with its bounding box, and the time each
pass took. `TagReading.upload` is the `ocrLines` and `barcodes` of the contract's `PhotoCreate`,
which the capture flow (T-12) sends with the photo. Reading is cancellable: cancel the task and it
throws `CancellationError` at the next pass or tile.

Vision quirks it handles:

- Vision returns some Latin capitals as Cyrillic or Greek look-alikes ("AСMЕ"), even with Latin
  languages only. Lines whose only non-Latin letters are such look-alikes are folded to Latin.
- The simulator cannot run the current barcode detector (revision 4 fails, revision 3 finds
  nothing), so in the simulator the reader uses revision 2 on the CPU. Devices always use the
  current revision, which the simulator tests therefore do not exercise.

The tests read synthetic tag photos in
`Packages/Features/Tests/TagReadingFeatureTests/Fixtures`, with their expected text and barcodes
in `manifest.json`. `Tools/generate-tag-fixtures.swift` draws them (system fonts, GS1 bar tables,
Core Image's Code 128 and QR generators); nothing is downloaded. To change a fixture, edit the
generator and run `make ios-tag-fixtures` on a Mac, then commit the images and manifest. A test
fails if the whole-photo pass starts reading a size-tab fixture on its own, so the fixtures keep
exercising the size-tab pass.

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
- Only the Dev Info.plist carries the ATS local-networking exception
  (`NSAllowsLocalNetworking`). XcodeGen derives it from the shared plist, and
  `make ios-check-ats` (part of `make ios-test`) fails if Staging or Prod would ship it.
- The Staging and Prod hosts end in `.invalid` and never resolve. The real domains arrive with
  the AWS accounts (gate G-AWS, T-30).
- To point Dev at a different port or host (for example a LAN address for a physical device),
  copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored) and set
  `API_BASE_URL` there.
- No configuration value is a secret. Never put credentials in an xcconfig file.
