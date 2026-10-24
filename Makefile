# iOS app commands (apps/ios). The backend uses npm scripts; see README.md.
#
# Everything Xcode writes (DerivedData, SwiftPM checkouts and caches, test results) stays in
# .build/ios inside this checkout. Tests run on an existing simulator and never create one.

IOS_DIR := apps/ios
IOS_PROJECT := $(IOS_DIR)/Listora.xcodeproj
IOS_BUILD_DIR := $(CURDIR)/.build/ios
IOS_SIMULATOR ?= iPhone 17
IOS_DESTINATION := platform=iOS Simulator,name=$(IOS_SIMULATOR)

XCODEBUILD := xcodebuild \
	-project $(IOS_PROJECT) \
	-scheme Listora \
	-configuration Dev-Debug \
	-destination '$(IOS_DESTINATION)' \
	-derivedDataPath $(IOS_BUILD_DIR)/DerivedData \
	-clonedSourcePackagesDirPath $(IOS_BUILD_DIR)/SourcePackages \
	-packageCachePath $(IOS_BUILD_DIR)/PackageCache \
	-skipPackagePluginValidation \
	-quiet

# Fails with an install hint when a command-line tool is missing.
require = @command -v $(1) >/dev/null 2>&1 || { echo "error: $(1) not found. Install it with: brew install $(2)" >&2; exit 1; }

.PHONY: ios-generate ios-build ios-test ios-check-ats ios-lint ios-format ios-open ios-clean ios-simulator \
	ios-tag-fixtures

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

## Check that only the Dev app Info.plist carries the ATS exception, so Staging and Prod ship
## without it.
ios-check-ats: ios-generate
	@for config in Dev-Debug Staging-Release Prod-Release; do \
		plist=$$(xcodebuild -project $(IOS_PROJECT) -target Listora -configuration $$config -showBuildSettings 2>/dev/null \
			| awk -F ' = ' '$$1 ~ /^ *INFOPLIST_FILE$$/ { print $$2 }'); \
		[ -n "$$plist" ] || { echo "error: no INFOPLIST_FILE for $$config" >&2; exit 1; }; \
		if plutil -extract NSAppTransportSecurity xml1 -o /dev/null "$(IOS_DIR)/$$plist" 2>/dev/null; then ats=yes; else ats=no; fi; \
		case "$$config:$$ats" in \
			Dev-Debug:yes|Staging-Release:no|Prod-Release:no) ;; \
			*) echo "error: $$config Info.plist ($$plist) NSAppTransportSecurity present: $$ats. Only the Dev-Debug Info.plist must have it." >&2; exit 1 ;; \
		esac; \
	done

## Run unit, package, and UI tests on the simulator. Results: .build/ios/Test.xcresult.
## Parallel testing is off because it would clone the simulator.
ios-test: ios-generate ios-simulator ios-check-ats
	rm -rf $(IOS_BUILD_DIR)/Test.xcresult
	$(XCODEBUILD) test -parallel-testing-enabled NO -resultBundlePath $(IOS_BUILD_DIR)/Test.xcresult

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

## Generate the project and open it in Xcode.
ios-open: ios-generate
	open $(IOS_PROJECT)

## Delete the generated project and everything under .build/ios.
ios-clean:
	rm -rf $(IOS_PROJECT) $(IOS_DIR)/Generated $(IOS_BUILD_DIR)
