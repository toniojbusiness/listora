# iOS app

The details and commands are in [apps/ios/README.md](../../apps/ios/README.md).

- `apps/ios/project.yml` is the only source of the Xcode project. XcodeGen generates
  `Listora.xcodeproj`, which is gitignored and never edited by hand.
- Swift 6 language mode with complete strict concurrency, and warnings are errors.
- Code lives in local Swift packages: `Core` (models and utilities, no UI), `DesignSystem`
  (palette, typography, spacing, components), `APIClient` (the client generated from the
  OpenAPI contract, with the session's bearer token and the error model), and `Features` (one
  library per feature). A feature never imports another
  feature; `AppFeature` composes them into the tab shell. The app target only starts
  `AppFeature`; the Share Extension target only starts `ShareLinkFeature`. When one feature
  opens another's screens (Add Item opens the review), it gets a view builder from
  `AppDependencies` and talks through a value type in `Core` (`ItemReviewRequest`,
  `ItemReviewOutcome`).
- The app and the Share Extension share the signed-in session through an App Group
  (`APP_GROUP_IDENTIFIER` in `Base.xcconfig`): the session is a keychain item in the group's
  access group (`KeychainAccessGrantStorage.session(appGroup:)`).
- Configuration comes only from the build configuration's xcconfig file (`Dev-Debug`,
  `Staging-Release`, `Prod-Release`) through Info.plist. `AppConfiguration` validates it at
  launch and stops the app with an error that names the bad key. Only Dev may use plain HTTP.
- On-device state the user creates (drafts and their photos) is written to the GRDB database
  first, and work against the server goes through a persistent queue whose every request has a
  stored `Idempotency-Key`, so it resumes after a relaunch without duplicates and shows each
  failure with a Retry. The Add Item upload queue is the model (`apps/ios/README.md`).
  Interactive steps (review, cost, price) save to the server before the next screen opens, so a
  relaunch resumes from the server's state; every wait on the server has a deadline and ends in
  a failure with a Retry, never an endless spinner ([review.md](review.md)).
- A screen's `.task` loads its data once: SwiftUI can show a screen again, restarting its task,
  while later screens are pushed over it, so a flow's model guards its first load
  (`ReviewFlowModel.appeared()`). A setting that a navigation host reads lives in its model, not
  in `@AppStorage`, which redraws the view on every `UserDefaults` write.
- Views use `DesignSystem` tokens and components, never raw colors, sizes, or their own button
  and card styling, so light and dark mode stay consistent. A test checks WCAG AA contrast for
  every text and background pair. The design system and its rules are in
  [design.md](design.md).
- Tests use Swift Testing; UI tests use XCTest. `make ios-lint` (SwiftLint and SwiftFormat)
  must be clean.
- Releases are plain `xcodebuild`, no fastlane: `scripts/ios-release.sh` archives
  (`make ios-archive` unsigned, `make ios-testflight` signed with an App Store Connect team API
  key and uploaded). The hand-dispatched TestFlight workflow runs it; the build number is the
  workflow's run number. Bundle ids and the team id are xcconfig settings.
