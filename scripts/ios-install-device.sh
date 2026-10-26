#!/usr/bin/env bash
# Builds the iPhone app for a physical iPhone connected to this Mac, signs it with the Apple ID
# signed in to Xcode (a free Personal Team works), installs it, and launches it. Run through make
# from the repository root:
#
#   make ios-install-device [IOS_DEVICE_CONFIGURATION=Prod-Release] [IOS_DEVICE=<udid or name>]
#
# Signing comes from apps/ios/Config/Device.xcconfig (gitignored; copy Device.xcconfig.example):
# the team id and a bundle id prefix of your own. Config/PersonalTeam.xcconfig applies them, and
# shares the session through Keychain Sharing instead of an App Group, over the configuration it
# builds, so the committed settings stay unchanged. The project must already be generated
# (`make ios-generate`). The guide is "Installing on your iPhone" in apps/ios/README.md.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
build_dir=${IOS_BUILD_DIR:-$repo_root/.build/ios}
project=$repo_root/apps/ios/Listora.xcodeproj
device_config=$repo_root/apps/ios/Config/Device.xcconfig
# Applies Device.xcconfig and the Personal Team signing settings (no App Group) over the build.
signing_config=$repo_root/apps/ios/Config/PersonalTeam.xcconfig
configuration=${IOS_DEVICE_CONFIGURATION:-Prod-Release}
device=${IOS_DEVICE:-}

fail() {
  echo "error: $*" >&2
  exit 1
}

# Prints the value of a setting in Device.xcconfig, empty when unset.
setting() {
  sed -n "s|^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*|\1|p" "$device_config" | tail -n 1
}

# Prints the team ids of the Apple Development certificates in the login keychain, which Xcode
# creates when an Apple ID is signed in to it. A certificate's OU is its team id.
signing_teams() {
  security find-certificate -a -c "Apple Development" -p 2>/dev/null |
    awk '/BEGIN CERTIFICATE/ { cert = "" } { cert = cert $0 "\n" } /END CERTIFICATE/ { printf "%s", cert | "openssl x509 -noout -subject -nameopt multiline"; close("openssl x509 -noout -subject -nameopt multiline") }' |
    sed -n 's/^ *organizationalUnitName *= *//p' | sort -u
}

check_device_config() {
  [[ -f $device_config ]] ||
    fail "No apps/ios/Config/Device.xcconfig. Copy Config/Device.xcconfig.example to Config/Device.xcconfig and set DEVELOPMENT_TEAM and BASE_BUNDLE_IDENTIFIER (\"Installing on your iPhone\" in apps/ios/README.md)."
  team=$(setting DEVELOPMENT_TEAM)
  prefix=$(setting BASE_BUNDLE_IDENTIFIER)
  if [[ ! $team =~ ^[A-Z0-9]{10}$ ]]; then
    local teams
    teams=$(signing_teams | paste -sd ' ' -)
    if [[ -n $teams ]]; then
      fail "Set DEVELOPMENT_TEAM in apps/ios/Config/Device.xcconfig to your 10-character team id. Teams with a signing certificate on this Mac: $teams"
    fi
    fail "Set DEVELOPMENT_TEAM in apps/ios/Config/Device.xcconfig to your 10-character team id. Sign in to Xcode (Xcode > Settings > Accounts), select the Personal Team, click Manage Certificates, click +, choose Apple Development, and run this again to see the id."
  fi
  [[ $prefix =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] ||
    fail "Set BASE_BUNDLE_IDENTIFIER in apps/ios/Config/Device.xcconfig to a reverse-DNS id only you use, such as com.yourname.listora."
  [[ $prefix != com.listora.app ]] ||
    fail "BASE_BUNDLE_IDENTIFIER must not be com.listora.app: that id is reserved for the paid Apple Developer account. Use one of your own, such as com.yourname.listora."
}

# Sets device to the UDID of the connected iPhone: IOS_DEVICE (a UDID or device name) or, when
# unset, the only physical iPhone connected.
find_device() {
  local listing
  listing=$(mktemp)
  trap 'rm -f "$listing"' RETURN
  xcrun devicectl list devices --quiet --json-output "$listing" >/dev/null ||
    fail "xcrun devicectl could not list devices. Open Xcode once to finish installing its components."
  local matches
  matches=$(node -e '
const [listing, wanted] = process.argv.slice(1);
for (const d of JSON.parse(require("fs").readFileSync(listing, "utf8")).result.devices) {
  const hw = d.hardwareProperties ?? {}, props = d.deviceProperties ?? {}, conn = d.connectionProperties ?? {};
  // Only a physical iPhone that is connected now (a known but absent one has no transport).
  if (hw.reality !== "physical" || hw.platform !== "iOS" || !conn.transportType) continue;
  if (wanted && wanted !== hw.udid && wanted !== props.name) continue;
  console.log([hw.udid, conn.pairingState === "paired" ? "paired" : "unpaired", props.developerModeStatus ?? "unknown", props.name].join("\t"));
}' "$listing" "$device")
  [[ -n $matches ]] || {
    [[ -n $device ]] && fail "No connected iPhone named or with UDID '$device'. Run: xcrun devicectl list devices"
    fail "No iPhone connected. Connect it to this Mac with a cable, unlock it, and tap Trust."
  }
  (($(wc -l <<<"$matches") == 1)) ||
    fail "More than one iPhone is connected; pass one with IOS_DEVICE='<udid or name>':"$'\n'"$matches"
  local udid pairing developer_mode name
  IFS=$'\t' read -r udid pairing developer_mode name <<<"$matches"
  [[ $pairing == paired ]] ||
    fail "$name is not paired with this Mac. Unlock it, tap Trust when it asks, and run this again."
  [[ $developer_mode != disabled ]] ||
    fail "Developer Mode is off on $name. Turn it on in Settings > Privacy & Security > Developer Mode, restart the iPhone, and tap Turn On."
  device=$udid
  echo "Installing on $name ($udid)."
}

build() {
  # -allowProvisioningUpdates lets Xcode register the bundle ids, the App Group, and this iPhone
  # with the team, and create the provisioning profiles, using the Apple ID signed in to Xcode.
  xcodebuild build \
    -project "$project" \
    -scheme Listora \
    -configuration "$configuration" \
    -destination "id=$device" \
    -xcconfig "$signing_config" \
    -derivedDataPath "$build_dir/DeviceDerivedData" \
    -clonedSourcePackagesDirPath "$build_dir/SourcePackages" \
    -packageCachePath "$build_dir/PackageCache" \
    -skipPackagePluginValidation \
    -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration \
    -quiet ||
    fail "The build failed. If it is a signing error, check that Xcode > Settings > Accounts shows your Apple ID and that DEVELOPMENT_TEAM and BASE_BUNDLE_IDENTIFIER in Config/Device.xcconfig are yours."
}

install_and_launch() {
  local app=$build_dir/DeviceDerivedData/Build/Products/$configuration-iphoneos/Listora.app
  [[ -d $app ]] || fail "The build has no app at $app"
  local bundle_id
  bundle_id=$(plutil -extract CFBundleIdentifier raw -o - "$app/Info.plist")
  xcrun devicectl device install app --device "$device" "$app" ||
    fail "Installing failed. A free Apple ID can have at most 3 apps from Xcode on an iPhone at a time; delete an old one from the iPhone if that is the reason."
  if ! xcrun devicectl device process launch --device "$device" --terminate-existing "$bundle_id"; then
    echo "error: $bundle_id is installed but did not launch. If the iPhone says \"Untrusted Developer\", open Settings > General > VPN & Device Management, tap your Apple ID under Developer App, tap Trust, then open Listora from the Home Screen or run this again." >&2
    exit 1
  fi
  echo "Listora ($bundle_id, $configuration) is installed and running. A free Apple ID's build stops opening after 7 days; run make ios-install-device again to renew it."
}

[[ -d $project ]] || fail "No $project. Run: make ios-generate"
check_device_config
find_device
build
install_and_launch
