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
| `make ios-app-icon`     | Re-render the placeholder app icon (see App icon)              |
| `make ios-archive`      | Unsigned release archive; needs no Apple account (Releases)    |
| `make ios-testflight`   | Signed release archive uploaded to TestFlight (Releases)       |

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
  APIClient/     The generated ListoraAPI client over URLSession, the signed-in session (Keychain),
                 APIFailure (the contract's error model), and the dev sign-in client
  Features/      One library per feature:
    AppFeature        Root tab shell and AppDependencies (composes the features)
    InventoryFeature  Inventory tab
    AddItemFeature    Add Item tab: guided capture, library import, drafts (GRDB), upload queue
    TasksFeature      Tasks tab
    SettingsFeature   Settings tab, with the developer sign-in in Dev builds
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
which the upload queue sends with each tag photo. Reading is cancellable: cancel the task and it
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

## App icon

The icon is the `AppIcon` set in `Listora/Assets.xcassets`, named by
`ASSETCATALOG_COMPILER_APPICON_NAME` in `project.yml`. It holds three 1024 x 1024 PNGs, and
Xcode derives every smaller size from them:

| File                 | Appearance | Requirements                                   |
| -------------------- | ---------- | ---------------------------------------------- |
| `AppIcon.png`        | Default    | Opaque (no alpha channel); App Store icon too  |
| `AppIcon-Dark.png`   | Dark       | Transparent background; iOS draws the backdrop |
| `AppIcon-Tinted.png` | Tinted     | Grayscale on transparent; iOS applies the tint |

The Share Extension has no icon of its own; the share sheet shows the containing app's icon.

The current icon is a placeholder: a price tag on the brand teal, drawn by
`Tools/generate-app-icon.swift`. To change it, edit that tool and run `make ios-app-icon`. To
ship a real design, export the three PNGs above from the design file, replace the files (keep
the names, or update `Contents.json`), delete the tool and the `ios-app-icon` target, and run
`make ios-test` and `make ios-archive`. Both check that the built app names the `AppIcon` asset.

## Add Item: capture, drafts, and uploads

`AddItemFeature` turns photos into a draft on the phone and uploads it in the background.
`AppDependencies` builds its `AddItemEnvironment`.

- **Capture.** On a device, "Take photos" opens a guided camera (AVFoundation): front, back,
  tag, then any number of flaws and details, each shot getting its step's role. The simulator
  has no camera, so it offers "Import photos" (PhotosPicker) only; imported photos get roles from
  their order (front, back, then detail).
- **Preparation** (`PhotoPreparation`): every photo is decoded upright, resized to at most 2048
  px on the long edge, and re-encoded as JPEG without any metadata, so no GPS location leaves
  the phone. `BlurDetector` scores sharpness (variance of the Laplacian at 1024 px) and capture
  asks "Retake or keep?" for a blurry shot; the editor marks it.
- **Editing.** The draft editor reorders (drag, or "Make cover"), removes, crops, and sets each
  photo's role. Cropping replaces the photo with a new one.
- **Drafts** live in a GRDB (SQLite) database with the photo files in Application Support
  (`DraftDatabase`; schema changes only through new migrations). A draft and its upload progress
  survive the app being closed.
- **Upload queue** (`PhotoUploader`, steps chosen by the pure `UploadPlanner`). For each draft it
  creates the server item (`createItem`), and for each photo it reads tag photos on the device
  (`TagReader`), requests an upload session, sends the bytes from the file through a background
  `URLSession` (they keep going while the app is suspended), and attaches the file with its role
  and tag reads. Then it sends role and order changes and deletes what the user removed (a
  `serverDeletion` row records each). Every request has a stored `Idempotency-Key`, so after a
  relaunch the queue resumes where it stopped: a photo whose transfer was interrupted first asks
  `getUploadSession` what arrived. Failures retry by `RetryPolicy` (2 s doubling to 5 minutes,
  with jitter, 8 attempts), then stop with the server's reason and a Retry button. Nothing is
  sent while signed out; a `401` signs out and the queue waits for the next sign-in.
- **Status.** Each photo shows Waiting to upload, Reading tag, Uploading, Retrying (n of 8), Sign
  in to upload, Upload failed, or Uploaded; "Uploaded" means the server attached the photo with
  its current role. The draft says "Saved to Listora" only when every photo is attached in order.

The queue's tests (`AddItemFeatureTests`) run the real generated client and URLSession transport
against `FakeListoraServer` through a `URLProtocol` stub, including resume after a relaunch,
retries, and failures that stop. The UI tests import the photos in `ListoraUITests/Fixtures`
through two debug-only launch variables: `LISTORA_FIXTURE_PHOTOS=<folder>` makes "Import photos"
add that folder's JPEGs, and `LISTORA_RESET_LOCAL_DATA=1` starts with no drafts, signed out.

### Signing in (Dev)

Uploads need a session. Until production sign-in (Cognito, T-31), Dev builds have a developer
sign-in in Settings: enter an email, tap "Send code", and enter the code the API prints to its
log (`AUTH_DRIVER=dev`). The session is kept in the Keychain. These `/dev/auth` endpoints are
outside the OpenAPI contract, so `DevSignInClient` is the one place the app calls the API without
the generated client.

## Environments

Each build configuration reads one xcconfig file in `Config/`, and `AppConfiguration` reads the
values from Info.plist at launch. A missing or invalid value stops the app at launch with an
error that names the key.

| Configuration     | xcconfig                  | `API_BASE_URL`                                                                           | Bundle id suffix |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| `Dev-Debug`       | `Config/Dev.xcconfig`     | `http://127.0.0.1:3000` (local API)                                                      | `.dev`           |
| `Staging-Release` | `Config/Staging.xcconfig` | placeholder `.invalid` host                                                              | `.staging`       |
| `Prod-Release`    | `Config/Prod.xcconfig`    | the personal environment's `ApiUrl` (placeholder `.invalid` host until its first deploy) | none             |

- Run and test use `Dev-Debug`; archive uses `Prod-Release`. The build type is part of each
  name because Xcode gives Swift packages debug settings only for configurations whose name
  contains "Debug".
- Dev uses plain HTTP so the simulator can reach `npm run dev:api` on this Mac. Staging and
  Prod must use HTTPS; `AppConfiguration` rejects anything else.
- Only the Dev Info.plist carries the ATS local-networking exception
  (`NSAllowsLocalNetworking`). XcodeGen derives it from the shared plist, and
  `make ios-check-ats` (part of `make ios-test`) fails if Staging or Prod would ship it.
- The Staging and Prod hosts end in `.invalid` and never resolve until they are set. Prod
  points at the personal environment, which is production for now (there is no separate
  Personal configuration): at that environment's first deploy, set its `API_BASE_URL` to the
  compute stack's `ApiUrl` output, `https://api.<domain>`
  ([infra/README.md](../../infra/README.md#the-personal-environment)). Staging's domain arrives
  with the staging AWS account (gate G-AWS, T-30).
- To point Dev at a different port or host (for example a LAN address for a physical device),
  copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored) and set
  `API_BASE_URL` there.
- No configuration value is a secret. Never put credentials in an xcconfig file.

## Releases

Release builds are plain `xcodebuild`, run by `scripts/ios-release.sh` (no fastlane). Signing
uses an App Store Connect team API key, never a personal Apple ID.

| Command               | What it does                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `make ios-archive`    | Archive `Prod-Release` without signing, then check the archive           |
| `make ios-testflight` | Archive with automatic signing, then sign for distribution and upload it |

Both take `IOS_RELEASE_CONFIGURATION` (`Prod-Release`, the default, or `Staging-Release`) and
`IOS_BUILD_NUMBER` (the CFBundleVersion, a whole number; required for TestFlight). For example
`make ios-archive IOS_RELEASE_CONFIGURATION=Staging-Release IOS_BUILD_NUMBER=7` writes
`.build/ios/archives/Listora-Staging-Release-unsigned.xcarchive`. After archiving, the script
checks that the app and the Share Extension have the same version and build number, that the
extension's bundle id is the app's plus `.share`, that the app is the requested environment, that
it has the `AppIcon` icon, and that it has no ATS exception. The unsigned archive cannot be installed or uploaded; it proves
that the release configuration compiles and archives without credentials.

`make ios-testflight` reads `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_PRIVATE_KEY` (the contents of the `.p8` file), and `APPLE_TEAM_ID` from the
environment (see `.env.example`), and stops before building when one is missing. It writes the
key to a private temporary file that it deletes when it ends.

### Uploading a TestFlight build

1. Merge the change to `main`. To start a new version, raise `MARKETING_VERSION` in
   `Config/Base.xcconfig` in that change.
2. In GitHub, open Actions > **TestFlight** > Run workflow, keep the `main` branch, and choose
   `staging` (the Listora Staging app) or `prod` (the Listora app). The run waits for the
   approval rules of the `ios-staging` or `ios-prod` environment.
3. The workflow (`.github/workflows/testflight.yml`, macOS runner) first checks that the four
   secrets exist and stops with an error naming any that are missing. Then it runs
   `make ios-testflight` with the build number set to the workflow's run number.
4. When the run succeeds, App Store Connect processes the build (usually a few minutes) and it
   appears in TestFlight for internal testers. External testing needs Beta App Review.

The run number goes up by one for each run of the workflow, for both apps, so build numbers
always increase. Re-running a run reuses its number; if that run already uploaded, App Store
Connect rejects the duplicate, so a build is never replaced. Renaming or recreating
`testflight.yml` restarts the run number; if that ever happens, raise `MARKETING_VERSION` before
the next upload, because App Store Connect needs a build number it has not seen for the version.

The workflow never runs on pushes or pull requests (macOS minutes cost 10 times Linux minutes).

### One-time setup (gate G-Apple)

What the captain creates once the Apple Developer Program account exists. The ids below use the
placeholder `BASE_BUNDLE_IDENTIFIER` (`com.listora.app`, in `Config/Base.xcconfig`). If that id
is taken, choose another, change `BASE_BUNDLE_IDENTIFIER` (the only place it is set), and use
the new one everywhere below.

1. **Team id.** Enroll as an organization (needs a D-U-N-S number). Note the 10-character team
   id from developer.apple.com > Account > Membership details.
2. **Bundle ids.** In Certificates, Identifiers & Profiles > Identifiers, register explicit App
   IDs:

   | App             | App id                    | Share Extension id              |
   | --------------- | ------------------------- | ------------------------------- |
   | Listora (Prod)  | `com.listora.app`         | `com.listora.app.share`         |
   | Listora Staging | `com.listora.app.staging` | `com.listora.app.staging.share` |

   Dev (`com.listora.app.dev`) is only for running on a device from Xcode; automatic signing
   registers it when needed.

3. **App Groups.** Register `group.com.listora.app` and `group.com.listora.app.staging`, and
   enable the App Groups capability with its environment's group on both the app id and the
   Share Extension id. The app and the Share Extension share data through it; the entitlement
   arrives with the Share Extension work (T-22). Later tasks enable more capabilities on the app
   ids the same way (Sign in with Apple in T-31, In-App Purchase in T-28, Push Notifications).
4. **App records.** In App Store Connect > Apps > New App, create two iOS apps: **Listora** with
   bundle id `com.listora.app`, and **Listora Staging** with `com.listora.app.staging`. Staging
   is only ever distributed through TestFlight.
5. **API key.** In App Store Connect > Users and Access > Integrations > App Store Connect API >
   Team Keys, generate a key (for example "GitHub TestFlight") with the **Admin** role. Automatic
   signing creates provisioning profiles and signs with a cloud-managed distribution
   certificate, which lower roles cannot do; individual keys cannot use the provisioning
   endpoints at all. Download the `.p8` file (Apple offers it only once), and note the key id
   and the issuer id shown on that page.
6. **GitHub environments.** In the repository's Settings > Environments, create `ios-staging`
   and `ios-prod`, limit both to the `main` branch, and add required reviewers to `ios-prod`.
   Add these secrets to each (the same key can serve both):

   | Secret                          | Value                                              |
   | ------------------------------- | -------------------------------------------------- |
   | `APP_STORE_CONNECT_KEY_ID`      | The key id                                         |
   | `APP_STORE_CONNECT_ISSUER_ID`   | The issuer id                                      |
   | `APP_STORE_CONNECT_PRIVATE_KEY` | The whole `.p8` file, BEGIN and END lines included |
   | `APPLE_TEAM_ID`                 | The team id                                        |

   These environments are separate from the AWS `staging` and `prod` deploy environments, so the
   Apple key and the AWS deploy role never share one.

7. **App icon.** App Store Connect rejects an upload without an app icon. The app ships the
   placeholder icon (see App icon); replace it with the real design before a public release.

Notes:

- `ITSAppUsesNonExemptEncryption` is `false` in Info.plist, so TestFlight does not ask the export
  compliance question for each build.
- Each fresh runner has no development certificate, so the signed archive step may create one
  ("Created via API" in Certificates). If they pile up toward Apple's limit, revoke the old ones;
  distribution signing is cloud-managed and is not affected.
- If the key leaks, revoke it in App Store Connect, generate a new one, and replace the secrets.
