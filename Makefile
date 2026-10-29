# iOS app commands (apps/ios). The backend uses npm scripts; see README.md.
#
# Everything Xcode writes (DerivedData, SwiftPM checkouts and caches, test results) stays in
# .build/ios inside this checkout. Tests run on an existing simulator and never create one.

IOS_DIR := apps/ios
IOS_PROJECT := $(IOS_DIR)/Listora.xcodeproj
IOS_BUILD_DIR := $(CURDIR)/.build/ios
IOS_SIMULATOR ?= iPhone 17
# One exact device by its UDID instead of the name, which can match a device per installed iOS
# runtime: CI sets it (scripts/ios-ci-simulator.sh).
IOS_SIMULATOR_ID ?=
comma := ,
lparen := (
rparen := )
# How `simctl list` shows the device: "(<UDID>)", or the name indented before its UDID.
IOS_SIMULATOR_MATCH := $(if $(IOS_SIMULATOR_ID),$(lparen)$(IOS_SIMULATOR_ID)$(rparen),    $(IOS_SIMULATOR) $(lparen))
IOS_DESTINATION := platform=iOS Simulator$(comma)$(if $(IOS_SIMULATOR_ID),id=$(IOS_SIMULATOR_ID),name=$(IOS_SIMULATOR))

# Every xcodebuild call keeps its SwiftPM checkouts and caches in .build/ios, including the ones
# that only read build settings, because they resolve the packages too.
IOS_PACKAGE_PATHS := \
	-clonedSourcePackagesDirPath $(IOS_BUILD_DIR)/SourcePackages \
	-packageCachePath $(IOS_BUILD_DIR)/PackageCache

# Optional Xcode compilation cache: a directory of compiler outputs keyed by their inputs' contents,
# so unlike DerivedData it stays valid in a fresh checkout. CI sets it to a directory it keeps
# between runs (the CI section of README.md); a warm cache cuts a clean build to about a third.
# Off by default, because it grows to about 1.5 GB.
IOS_COMPILATION_CACHE ?=
IOS_CACHE_SETTINGS := $(if $(IOS_COMPILATION_CACHE),COMPILATION_CACHE_ENABLE_CACHING=YES \
	COMPILATION_CACHE_CAS_PATH='$(IOS_COMPILATION_CACHE)')

XCODEBUILD := xcodebuild \
	-project $(IOS_PROJECT) \
	-scheme Listora \
	-configuration Dev-Debug \
	-destination '$(IOS_DESTINATION)' \
	-derivedDataPath $(IOS_BUILD_DIR)/DerivedData \
	$(IOS_PACKAGE_PATHS) \
	-skipPackagePluginValidation \
	-quiet \
	$(IOS_CACHE_SETTINGS)

# Release builds (scripts/ios-release.sh; release guide in apps/ios/README.md). The build number
# defaults to CURRENT_PROJECT_VERSION in Config/Base.xcconfig for ios-archive and is required by
# ios-testflight.
IOS_RELEASE_CONFIGURATION ?= Prod-Release
IOS_BUILD_NUMBER ?=
IOS_RELEASE := IOS_BUILD_DIR='$(IOS_BUILD_DIR)' scripts/ios-release.sh

# The local stack the UI tests run against (packages/e2e), wrapped around a command.
E2E_STACK := node --env-file-if-exists=.env packages/e2e/src/cli.ts \
	--fake-ai-fixtures $(IOS_DIR)/ListoraUITests/FakeAI \
	--log-dir $(IOS_BUILD_DIR)/e2e-logs

# Fails with an install hint when a command-line tool is missing.
require = @command -v $(1) >/dev/null 2>&1 || { echo "error: $(1) not found. Install it with: brew install $(2)" >&2; exit 1; }

.PHONY: ios-generate ios-build ios-build-for-testing ios-test ios-unit-test ios-ui-test ios-e2e-ready ios-check-ats ios-screenshots ios-lint ios-format ios-open ios-clean \
	ios-simulator e2e-full \
	ios-tag-fixtures ios-batch-fixtures ios-app-icon ios-archive ios-testflight ios-install-device

## Generate Listora.xcodeproj from apps/ios/project.yml.
ios-generate:
	$(call require,xcodegen,xcodegen)
	xcodegen generate --quiet --spec $(IOS_DIR)/project.yml

## Check that the test simulator exists (it is reused, never created).
ios-simulator:
	@xcrun simctl list devices available | grep -qF "$(IOS_SIMULATOR_MATCH)" || { \
		echo "error: no available '$(or $(IOS_SIMULATOR_ID),$(IOS_SIMULATOR))' simulator. Install the iOS runtime in Xcode > Settings > Components, or pass IOS_SIMULATOR='<device name>'." >&2; \
		exit 1; }

## Build the app, Share Extension, and packages for the simulator.
ios-build: ios-generate ios-simulator
	$(XCODEBUILD) build

## Check that only the Dev Info.plists (app and Share Extension) carry the ATS exception, so
## Staging and Prod ship without it.
ios-check-ats: ios-generate
	@for target in Listora ShareExtension; do for config in Dev-Debug Staging-Release Prod-Release; do \
		plist=$$(xcodebuild -project $(IOS_PROJECT) -target $$target -configuration $$config $(IOS_PACKAGE_PATHS) -showBuildSettings 2>/dev/null \
			| awk -F ' = ' '$$1 ~ /^ *INFOPLIST_FILE$$/ { print $$2 }'); \
		[ -n "$$plist" ] || { echo "error: no INFOPLIST_FILE for $$target $$config" >&2; exit 1; }; \
		if plutil -extract NSAppTransportSecurity xml1 -o /dev/null "$(IOS_DIR)/$$plist" 2>/dev/null; then ats=yes; else ats=no; fi; \
		case "$$config:$$ats" in \
			Dev-Debug:yes|Staging-Release:no|Prod-Release:no) ;; \
			*) echo "error: $$target $$config Info.plist ($$plist) NSAppTransportSecurity present: $$ats. Only the Dev-Debug Info.plist must have it." >&2; exit 1 ;; \
		esac; \
	done; done

# A test that hangs (a UI test waiting on a stuck simulator) fails after 5 minutes instead of
# blocking the run. A failing test is retried up to twice: one that passes on a retry does not fail
# the run, but the summary lists it as flaky so it gets a follow-up fix (README, CI section).
# xcodebuild retries the unit and package tests itself; it never retried a UI test here, so the UI
# runs go through scripts/ios-test-run.sh, which runs the failed tests again.
IOS_TEST_LIMITS := -test-timeouts-enabled YES -default-test-execution-time-allowance 300 \
	-retry-tests-on-failure -test-iterations 3
# Optional file the failing-test summary of ios-unit-test or ios-ui-test is also written to (CI
# writes it into each job's summary).
IOS_TEST_SUMMARY_FILE ?=
# One shard of the UI tests, <shard>/<count> (for example 2/3): scripts/ios-ui-shard.sh splits the
# UI test classes by their recorded running time. Empty runs every UI test.
IOS_UI_SHARD ?=
# IOS_PREBUILT=1 runs ios-unit-test and ios-ui-test on the products already in DerivedData
# without building first: CI builds once and hands them to its test jobs.
IOS_PREBUILT ?=
IOS_TEST_BUILD := $(if $(IOS_PREBUILT),,ios-build-for-testing)
# The tests run from the .xctestrun file the build writes next to its products, not from the
# project: that needs nothing but the products (with -scheme and only the products, xcodebuild
# silently skips every package test bundle). The newest file, in case an older SDK's is left.
XCTEST := xcodebuild test-without-building \
	-xctestrun "$$(ls -t $(IOS_BUILD_DIR)/DerivedData/Build/Products/*-arm64.xctestrun 2>/dev/null | head -1)" \
	-destination '$(IOS_DESTINATION)' -quiet -parallel-testing-enabled NO $(IOS_TEST_LIMITS)
require_products = @ls $(IOS_BUILD_DIR)/DerivedData/Build/Products/*-arm64.xctestrun >/dev/null 2>&1 || { \
	echo "error: no built tests in $(IOS_BUILD_DIR)/DerivedData. Run: make ios-build-for-testing" >&2; exit 1; }

## Run unit, package, and UI tests on the simulator: the ATS check, then ios-unit-test and
## ios-ui-test (both run even when the first fails). Results: .build/ios/Unit.xcresult and
## .build/ios/UI.xcresult. Each run ends by naming the tests that failed and the ones that passed
## only on a retry.
ios-test: ios-check-ats
	@status=0; \
	$(MAKE) --no-print-directory ios-unit-test || status=1; \
	$(MAKE) --no-print-directory ios-ui-test || status=1; \
	exit $$status

## Build the app, the Share Extension, the packages, and every test target for the test runs.
ios-build-for-testing: ios-generate ios-simulator
	$(XCODEBUILD) build-for-testing

## Unit and package tests: every test target of the scheme but the UI tests. They need no backend.
## Parallel testing is off here and in ios-ui-test because it would clone the simulator.
ios-unit-test: ios-simulator $(IOS_TEST_BUILD)
	$(require_products)
	rm -rf $(IOS_BUILD_DIR)/Unit.xcresult
	@status=0; \
	$(XCTEST) -skip-testing:ListoraUITests -resultBundlePath $(IOS_BUILD_DIR)/Unit.xcresult || status=$$?; \
	scripts/ios-test-summary.sh '$(IOS_TEST_SUMMARY_FILE)' $(IOS_BUILD_DIR)/Unit.xcresult; \
	exit $$status

## UI tests (ListoraUITests), or the IOS_UI_SHARD shard of them. The ones that go through the
## backend run against the local stack (packages/e2e): the real API and worker with fakes, on a
## scratch database of this checkout's Postgres cluster. Its logs: .build/ios/e2e-logs.
ios-ui-test: ios-simulator $(IOS_TEST_BUILD) ios-e2e-ready
	$(require_products)
	rm -rf $(IOS_BUILD_DIR)/UI*.xcresult $(IOS_BUILD_DIR)/e2e-logs
	@if [ -n '$(IOS_UI_SHARD)' ]; then \
		tests=$$(scripts/ios-ui-shard.sh $(subst /, ,$(IOS_UI_SHARD))) || exit 2; \
		echo "UI test shard $(IOS_UI_SHARD):" $$(echo "$$tests" | sed 's|-only-testing:ListoraUITests/||'); \
	else \
		tests=-only-testing:ListoraUITests; \
	fi; \
	$(E2E_STACK) -- scripts/ios-test-run.sh $(IOS_BUILD_DIR)/UI.xcresult '$(IOS_TEST_SUMMARY_FILE)' -- \
		$(XCTEST) $$tests

## The full-stack end-to-end suite (docs/features/e2e.md): FullStackUITests on the simulator,
## against the full local stack (`--marketplaces all`): the API, the worker, and the browser
## runner, with the fake eBay, the fake Depop API, the fake Poshmark, Mercari, and Depop sites,
## and the fake AI. Nightly and on demand in CI (.github/workflows/e2e-full.yml), not per pull
## request. Results: .build/ios/E2EFull.xcresult; the stack's logs: .build/ios/e2e-full-logs.
## Each test may take 10 minutes; a failing one is retried as in ios-test.
E2E_FULL_STACK := node --env-file-if-exists=.env packages/e2e/src/cli.ts --marketplaces all \
	--fake-ai-fixtures $(IOS_DIR)/ListoraUITests/FullStack/FakeAI \
	--log-dir $(IOS_BUILD_DIR)/e2e-full-logs
E2E_FULL_LIMITS := -test-timeouts-enabled YES -default-test-execution-time-allowance 600 \
	-maximum-test-execution-time-allowance 900 -retry-tests-on-failure -test-iterations 3

e2e-full: ios-generate ios-simulator ios-check-ats ios-e2e-ready
	scripts/dev-browser.sh
	rm -rf $(IOS_BUILD_DIR)/E2EFull*.xcresult $(IOS_BUILD_DIR)/e2e-full-logs
	$(XCODEBUILD) build-for-testing
	$(E2E_FULL_STACK) -- scripts/ios-test-run.sh $(IOS_BUILD_DIR)/E2EFull.xcresult '$(IOS_TEST_SUMMARY_FILE)' -- \
		$(XCODEBUILD) test-without-building -only-testing:ListoraUITests/FullStackUITests \
		-parallel-testing-enabled NO $(E2E_FULL_LIMITS)

## Check that the local stack can start: backend dependencies installed, Postgres cluster running.
ios-e2e-ready:
	$(call require,node,node)
	@[ -d node_modules/@listora/e2e ] || { echo "error: backend dependencies are missing. Run: npm ci" >&2; exit 1; }
	scripts/dev-db.sh start

## Screenshot every screen in light and dark mode, at the default and the largest text size, into
## IOS_SCREENSHOT_DIR/<variant>/ (ScreenshotTourUITests). It switches the simulator's appearance
## and text size, then puts them back to light and the default size. The review screens go
## through the local stack, like `ios-test`. IOS_SCREENSHOT_TESTS narrows the tour, for example to
## ListoraUITests/ScreenshotTourUITests/testReviewTour.
IOS_SCREENSHOT_DIR ?= $(IOS_BUILD_DIR)/screenshots
IOS_SCREENSHOT_TESTS ?= ListoraUITests/ScreenshotTourUITests
IOS_SCREENSHOT_VARIANTS := light:large dark:large light:accessibility-extra-extra-extra-large \
	dark:accessibility-extra-extra-extra-large

ios-screenshots: ios-generate ios-simulator ios-e2e-ready
	$(XCODEBUILD) build-for-testing
	@# Appearance and text size can only be set on a booted simulator.
	xcrun simctl bootstatus "$(IOS_SIMULATOR)" -b >/dev/null
	@trap 'xcrun simctl ui "$(IOS_SIMULATOR)" appearance light; xcrun simctl ui "$(IOS_SIMULATOR)" content_size large' EXIT; \
	for variant in $(IOS_SCREENSHOT_VARIANTS); do \
		appearance=$${variant%%:*}; size=$${variant#*:}; \
		xcrun simctl ui "$(IOS_SIMULATOR)" appearance $$appearance && \
		xcrun simctl ui "$(IOS_SIMULATOR)" content_size $$size && \
		TEST_RUNNER_LISTORA_SCREENSHOT_DIR='$(IOS_SCREENSHOT_DIR)' \
		TEST_RUNNER_LISTORA_SCREENSHOT_VARIANT="$$appearance-$$size" \
			$(E2E_STACK) -- $(XCODEBUILD) test-without-building -only-testing:$(IOS_SCREENSHOT_TESTS) \
			-test-timeouts-enabled YES -default-test-execution-time-allowance 900 -collect-test-diagnostics never \
			|| exit 1; \
	done
	@echo "Screenshots: $(IOS_SCREENSHOT_DIR)"

## SwiftLint and the SwiftFormat check, both failing on any finding.
ios-lint:
	$(call require,swiftlint,swiftlint)
	$(call require,swiftformat,swiftformat)
	cd $(IOS_DIR) && swiftlint lint --strict --quiet
	cd $(IOS_DIR) && swiftformat --lint --quiet .

## Rewrite Swift files with SwiftFormat, then apply SwiftLint autocorrections.
ios-format:
	$(call require,swiftlint,swiftlint)
	$(call require,swiftformat,swiftformat)
	cd $(IOS_DIR) && swiftformat --quiet .
	cd $(IOS_DIR) && swiftlint lint --fix --quiet

## Re-render the synthetic tag photos and manifest that TagReadingFeatureTests reads.
ios-tag-fixtures:
	mkdir -p $(IOS_BUILD_DIR)/tools
	xcrun swiftc -O -o $(IOS_BUILD_DIR)/tools/generate-tag-fixtures $(IOS_DIR)/Tools/generate-tag-fixtures.swift
	$(IOS_BUILD_DIR)/tools/generate-tag-fixtures

## Re-render the synthetic haul photos that PhotoSignalsFeatureTests groups and the batch UI
## test shoots, then record their Vision signals for the grouping tests in CoreTests.
ios-batch-fixtures:
	mkdir -p $(IOS_BUILD_DIR)/tools
	xcrun swiftc -O -o $(IOS_BUILD_DIR)/tools/generate-batch-fixtures $(IOS_DIR)/Tools/generate-batch-fixtures.swift
	$(IOS_BUILD_DIR)/tools/generate-batch-fixtures
	xcrun swiftc -O -parse-as-library -o $(IOS_BUILD_DIR)/tools/record-batch-signals $(IOS_DIR)/Tools/record-batch-signals.swift
	$(IOS_BUILD_DIR)/tools/record-batch-signals

## Render the Looptag app icon PNGs (Brand/AppIcon.xcassets/AppIcon.appiconset) from the SVG
## sources in apps/ios/Brand.
ios-app-icon:
	$(call require,rsvg-convert,librsvg)
	mkdir -p $(IOS_BUILD_DIR)/tools
	xcrun swiftc -O -o $(IOS_BUILD_DIR)/tools/render-app-icon $(IOS_DIR)/Tools/render-app-icon.swift
	$(IOS_BUILD_DIR)/tools/render-app-icon $(IOS_DIR)/Brand

## Archive a release configuration without signing, to prove the archive step works with no
## Apple account. Output: .build/ios/archives/Listora-<configuration>-unsigned.xcarchive.
ios-archive: ios-generate ios-check-ats
	$(IOS_RELEASE) archive '$(IOS_RELEASE_CONFIGURATION)' '$(IOS_BUILD_NUMBER)'

## Archive, sign, and upload a release configuration to TestFlight. Needs IOS_BUILD_NUMBER and the
## App Store Connect credentials in the environment; it checks them before building.
ios-testflight:
	$(IOS_RELEASE) check-credentials
	$(MAKE) ios-generate ios-check-ats
	$(IOS_RELEASE) testflight '$(IOS_RELEASE_CONFIGURATION)' '$(IOS_BUILD_NUMBER)'

## Build, install, and launch the app on the iPhone connected to this Mac, signed with the Apple
## ID in Xcode (a free Personal Team works). Signing: Config/Device.xcconfig (gitignored).
## IOS_DEVICE_CONFIGURATION defaults to Prod-Release; IOS_DEVICE picks one of several iPhones.
IOS_DEVICE_CONFIGURATION ?= Prod-Release
IOS_DEVICE ?=

ios-install-device: ios-generate
	$(call require,node,node)
	IOS_BUILD_DIR='$(IOS_BUILD_DIR)' IOS_DEVICE_CONFIGURATION='$(IOS_DEVICE_CONFIGURATION)' \
		IOS_DEVICE='$(IOS_DEVICE)' scripts/ios-install-device.sh

## Generate the project and open it in Xcode.
ios-open: ios-generate
	open $(IOS_PROJECT)

## Delete the generated project and everything under .build/ios.
ios-clean:
	rm -rf $(IOS_PROJECT) $(IOS_DIR)/Generated $(IOS_BUILD_DIR)
