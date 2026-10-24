#!/usr/bin/env bash
# iOS release builds, run through make from the repository root:
#
#   make ios-archive    Unsigned archive of a release configuration. Needs no Apple account, so
#                       it proves the archive step works before gate G-Apple.
#   make ios-testflight Signed archive uploaded to TestFlight with an App Store Connect API key.
#                       .github/workflows/testflight.yml runs it.
#
# Usage:
#   scripts/ios-release.sh check-credentials
#   scripts/ios-release.sh archive <Staging-Release|Prod-Release> [build-number]
#   scripts/ios-release.sh testflight <Staging-Release|Prod-Release> <build-number>
#
# The project must already be generated (`make ios-generate`). testflight reads the credentials
# below from the environment and never prints them. The release guide is in apps/ios/README.md.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
build_dir=${IOS_BUILD_DIR:-$repo_root/.build/ios}
project=$repo_root/apps/ios/Listora.xcodeproj
export_options=$repo_root/apps/ios/Config/ExportOptions.plist

# The App Store Connect team API key (key id, issuer id, and the contents of its .p8 file) and
# the Apple Developer team id. In GitHub Actions they are secrets of the ios-staging and ios-prod
# environments, with the same names.
credential_names=(APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_PRIVATE_KEY APPLE_TEAM_ID)

fail() {
  if [[ ${GITHUB_ACTIONS:-} == true ]]; then echo "::error::$*" >&2; else echo "error: $*" >&2; fi
  exit 1
}

usage() {
  fail "usage: $0 check-credentials | archive <configuration> [build-number] | testflight <configuration> <build-number>"
}

check_credentials() {
  local missing=() name
  for name in "${credential_names[@]}"; do
    [[ -n ${!name:-} ]] || missing+=("$name")
  done
  if ((${#missing[@]} > 0)); then
    fail "Missing App Store Connect credentials: ${missing[*]}. In GitHub Actions, add them as secrets of the ios-staging or ios-prod environment; locally, export them. See \"Releases\" in apps/ios/README.md."
  fi
  [[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] ||
    fail "APPLE_TEAM_ID must be the 10-character team id from the Membership details on developer.apple.com."
  local pem_label="PRIVATE KEY"
  [[ $APP_STORE_CONNECT_PRIVATE_KEY == *"-----BEGIN $pem_label-----"*"-----END $pem_label-----"* ]] ||
    fail "APP_STORE_CONNECT_PRIVATE_KEY must be the whole contents of the AuthKey_<key id>.p8 file, including its BEGIN and END lines."
}

# Prints the LISTORA_ENVIRONMENT a release configuration builds.
environment_of() {
  case $1 in
    Staging-Release) echo staging ;;
    Prod-Release) echo prod ;;
    *) fail "Release configuration must be Staging-Release or Prod-Release, not '$1'." ;;
  esac
}

check_build_number() {
  [[ $1 =~ ^[1-9][0-9]{0,8}$ ]] ||
    fail "Build number must be a positive whole number (CFBundleVersion), not '$1'."
}

plist_value() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null || fail "$1 has no $2."
}

# Checks what App Store Connect checks first: the app and its Share Extension share one version
# and build number, the extension's bundle id extends the app's, and the build is the requested
# environment with the app icon and without the Dev-only ATS exception.
verify_archive() {
  local archive=$1 configuration=$2 build_number=$3
  local app=$archive/Products/Applications/Listora.app
  local extension=$app/PlugIns/ShareExtension.appex
  [[ -d $app ]] || fail "The archive has no Listora.app: $app"
  [[ -d $extension ]] || fail "The archive has no Share Extension: $extension"
  plist_value "$archive/Info.plist" ApplicationProperties.CFBundleIdentifier >/dev/null

  local app_id app_version app_build extension_id extension_version extension_build environment
  app_id=$(plist_value "$app/Info.plist" CFBundleIdentifier)
  app_version=$(plist_value "$app/Info.plist" CFBundleShortVersionString)
  app_build=$(plist_value "$app/Info.plist" CFBundleVersion)
  extension_id=$(plist_value "$extension/Info.plist" CFBundleIdentifier)
  extension_version=$(plist_value "$extension/Info.plist" CFBundleShortVersionString)
  extension_build=$(plist_value "$extension/Info.plist" CFBundleVersion)
  environment=$(plist_value "$app/Info.plist" ListoraEnvironment)

  [[ $environment == "$(environment_of "$configuration")" ]] ||
    fail "$configuration archive has ListoraEnvironment '$environment'."
  [[ -z $build_number || $app_build == "$build_number" ]] ||
    fail "The app's build number is $app_build, not $build_number."
  [[ $extension_id == "$app_id.share" ]] ||
    fail "The Share Extension bundle id $extension_id must be $app_id.share."
  [[ $extension_version == "$app_version" && $extension_build == "$app_build" ]] ||
    fail "The Share Extension is $extension_version ($extension_build) but the app is $app_version ($app_build)."
  [[ $(plist_value "$app/Info.plist" CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName) == AppIcon ]] ||
    fail "The app's Info.plist does not name the AppIcon asset."
  [[ -f $app/Assets.car ]] || fail "The app has no compiled asset catalog (Assets.car), so no icon."
  if plutil -extract NSAppTransportSecurity xml1 -o /dev/null "$app/Info.plist" 2>/dev/null; then
    fail "The $configuration app must not carry the Dev-only NSAppTransportSecurity exception."
  fi
  echo "Archived $app_id $app_version ($app_build), $environment: $archive"
}

# archive <configuration> <build number or empty> <archive path> [xcodebuild arguments...]
run_archive() {
  local configuration=$1 build_number=$2 archive=$3
  shift 3
  local settings=()
  [[ -z $build_number ]] || settings+=("CURRENT_PROJECT_VERSION=$build_number")
  rm -rf "$archive"
  # Builds for any iOS device; DerivedData and SwiftPM caches stay in the checkout (Makefile).
  xcodebuild archive \
    -project "$project" \
    -scheme Listora \
    -configuration "$configuration" \
    -destination 'generic/platform=iOS' \
    -archivePath "$archive" \
    -derivedDataPath "$build_dir/DerivedData" \
    -clonedSourcePackagesDirPath "$build_dir/SourcePackages" \
    -packageCachePath "$build_dir/PackageCache" \
    -skipPackagePluginValidation \
    -quiet \
    "$@" ${settings[@]+"${settings[@]}"}
  verify_archive "$archive" "$configuration" "$build_number"
}

command=${1:-}
case $command in
  check-credentials)
    (($# == 1)) || usage
    check_credentials
    echo "App Store Connect credentials are present."
    ;;
  archive)
    (($# == 2 || $# == 3)) || usage
    configuration=$2 build_number=${3:-}
    environment_of "$configuration" >/dev/null
    [[ -z $build_number ]] || check_build_number "$build_number"
    run_archive "$configuration" "$build_number" "$build_dir/archives/Listora-$configuration-unsigned.xcarchive" \
      CODE_SIGNING_ALLOWED=NO
    ;;
  testflight)
    (($# == 3)) || usage
    configuration=$2 build_number=$3
    environment_of "$configuration" >/dev/null
    [[ -n $build_number ]] || fail "TestFlight uploads need a build number: make ios-testflight IOS_BUILD_NUMBER=<n>."
    check_build_number "$build_number"
    check_credentials

    # The key exists only as a private file for this run.
    key_dir=$(mktemp -d)
    trap 'rm -rf "$key_dir"' EXIT
    key_path=$key_dir/AuthKey_$APP_STORE_CONNECT_KEY_ID.p8
    (umask 077 && printf '%s\n' "$APP_STORE_CONNECT_PRIVATE_KEY" >"$key_path")
    auth=(
      -allowProvisioningUpdates
      -authenticationKeyPath "$key_path"
      -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID"
      -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
    )

    archive=$build_dir/archives/Listora-$configuration.xcarchive
    run_archive "$configuration" "$build_number" "$archive" "${auth[@]}" "DEVELOPMENT_TEAM=$APPLE_TEAM_ID"
    # Re-signs for distribution and uploads (ExportOptions.plist). App Store Connect rejects a
    # build number it already has, so a repeated upload of one build fails instead of replacing it.
    rm -rf "$build_dir/export/$configuration"
    xcodebuild -exportArchive \
      -archivePath "$archive" \
      -exportOptionsPlist "$export_options" \
      -exportPath "$build_dir/export/$configuration" \
      "${auth[@]}"
    echo "Uploaded build $build_number of $configuration to App Store Connect. It appears in TestFlight after processing."
    ;;
  *) usage ;;
esac
