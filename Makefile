# iOS app commands (apps/ios). The backend uses npm scripts; see README.md.
#
# Everything Xcode writes (DerivedData, SwiftPM checkouts and caches, test results) stays in
# .build/ios inside this checkout. Tests run on an existing simulator and never create one.

IOS_DIR := apps/ios
IOS_PROJECT := $(IOS_DIR)/Listora.xcodeproj
IOS_BUILD_DIR := $(CURDIR)/.build/ios
IOS_SIMULATOR ?= iPhone 17
IOS_DESTINATION := platform=iOS Simulator,name=$(IOS_SIMULATOR)

# Every xcodebuild call keeps its SwiftPM checkouts and caches in .build/ios, including the ones
# that only read build settings, because they resolve the packages too.
IOS_PACKAGE_PATHS := \
	-clonedSourcePackagesDirPath $(IOS_BUILD_DIR)/SourcePackages \
	-packageCachePath $(IOS_BUILD_DIR)/PackageCache

XCODEBUILD := xcodebuild \
	-project $(IOS_PROJECT) \
	-scheme Listora \
	-configuration Dev-Debug \
	-destination '$(IOS_DESTINATION)' \
	-derivedDataPath $(IOS_BUILD_DIR)/DerivedData \
	$(IOS_PACKAGE_PATHS) \
	-skipPackagePluginValidation \
	-quiet

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

.PHONY: ios-generate ios-build ios-test ios-e2e-ready ios-check-ats ios-lint ios-format ios-open ios-clean ios-simulator \
	ios-tag-fixtures ios-app-icon ios-archive ios-testflight

## Generate Listora.xcodeproj from apps/ios/project.yml.
ios-generate:
	$(call require,xcodegen,xcodegen)
	xcodegen generate --quiet --spec $(IOS_DIR)/project.yml

## Check that the test simulator exists (it is reused, never created).
ios-simulator:
	@xcrun simctl list devices available | grep -q "    $(IOS_SIMULATOR) (" || { \
		echo "error: no available '$(IOS_SIMULATOR)' simulator. Install the iOS runtime in Xcode > Settings > Components, or pass IOS_SIMULATOR='<device name>'." >&2; \
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

## Run unit, package, and UI tests on the simulator. Results: .build/ios/Test.xcresult.
## Parallel testing is off because it would clone the simulator. The UI tests that go through the
## backend run against the local stack (packages/e2e): the real API and worker with fakes, on a
## scratch database of this checkout's Postgres cluster. Its logs: .build/ios/e2e-logs.
ios-test: ios-generate ios-simulator ios-check-ats ios-e2e-ready
	rm -rf $(IOS_BUILD_DIR)/Test.xcresult $(IOS_BUILD_DIR)/e2e-logs
	$(E2E_STACK) -- $(XCODEBUILD) test -parallel-testing-enabled NO -resultBundlePath $(IOS_BUILD_DIR)/Test.xcresult

## Check that the local stack can start: backend dependencies installed, Postgres cluster running.
ios-e2e-ready:
	$(call require,node,node)
	@[ -d node_modules/@listora/e2e ] || { echo "error: backend dependencies are missing. Run: npm ci" >&2; exit 1; }
	scripts/dev-db.sh start

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

## Re-render the placeholder app icon PNGs in Listora/Assets.xcassets/AppIcon.appiconset.
ios-app-icon:
	mkdir -p $(IOS_BUILD_DIR)/tools
	xcrun swiftc -O -o $(IOS_BUILD_DIR)/tools/generate-app-icon $(IOS_DIR)/Tools/generate-app-icon.swift
	$(IOS_BUILD_DIR)/tools/generate-app-icon $(IOS_DIR)/Listora/Assets.xcassets/AppIcon.appiconset

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

## Generate the project and open it in Xcode.
ios-open: ios-generate
	open $(IOS_PROJECT)

## Delete the generated project and everything under .build/ios.
ios-clean:
	rm -rf $(IOS_PROJECT) $(IOS_DIR)/Generated $(IOS_BUILD_DIR)
