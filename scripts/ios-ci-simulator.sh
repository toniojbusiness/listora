#!/usr/bin/env bash
# The CI iOS jobs' simulator: one exact device, booted, and seen by Xcode.
#
#   scripts/ios-ci-simulator.sh pick   # choose the device; exports IOS_SIMULATOR_ID (GITHUB_ENV)
#   scripts/ios-ci-simulator.sh start  # pick, then erase and boot it without waiting
#   scripts/ios-ci-simulator.sh wait   # wait until it has booted and Xcode lists it
#
# A runner image has an "iPhone 17" for each installed iOS runtime, so the name alone matched
# several devices, and `simctl boot` and xcodebuild could each take a different one. The device
# is the IOS_SIMULATOR model (default iPhone 17) on the runtime of the selected Xcode's
# simulator SDK, else the newest older runtime, else the newest; the Makefile targets it by id
# (IOS_SIMULATOR_ID). Once in a while xcodebuild listed no simulators at all right after a boot
# that simctl reported done (October 2026, main): `wait` checks that Xcode lists the device,
# and if not, restarts CoreSimulatorService and boots it again, up to three times.
set -euo pipefail

name=${IOS_SIMULATOR:-iPhone 17}

pick() {
  local sdk udid
  sdk=$(xcrun --sdk iphonesimulator --show-sdk-version)
  udid=$(xcrun simctl list devices available -j | jq -r --arg name "$name" --arg sdk "$sdk" '
    ($sdk | split(".") | map(tonumber)) as $want
    | [ .devices | to_entries[] | select(.key | test("SimRuntime\\.iOS-"))
        | (.key | sub(".*SimRuntime\\.iOS-"; "") | split("-") | map(tonumber)) as $version
        | .value[] | select(.name == $name) | {udid, version: $version} ]
    | (map(select(.version[0:2] == $want[0:2])) | first)
      // (map(select(.version < $want)) | sort_by(.version) | last)
      // (sort_by(.version) | last)
      // empty
    | .udid')
  if [[ -z $udid ]]; then
    echo "error: no available '$name' simulator (iOS simulator SDK $sdk)" >&2
    xcrun simctl list devices available >&2
    exit 1
  fi
  echo "Simulator: $name, $(xcrun simctl list devices available | grep "$udid" | sed 's/^ *//'), for SDK $sdk"
  export IOS_SIMULATOR_ID=$udid
  if [[ -n ${GITHUB_ENV:-} ]]; then echo "IOS_SIMULATOR_ID=$udid" >>"$GITHUB_ENV"; fi
}

# Whether Xcode lists the device, which is what xcodebuild's destination needs.
seen_by_xcode() {
  xcrun xctrace list devices 2>/dev/null | grep -q "$IOS_SIMULATOR_ID"
}

case "${1:-}" in
  pick)
    pick
    ;;
  start)
    pick
    xcrun simctl shutdown all
    xcrun simctl erase "$IOS_SIMULATOR_ID"
    xcrun simctl boot "$IOS_SIMULATOR_ID"
    ;;
  wait)
    : "${IOS_SIMULATOR_ID:?run 'start' first (it exports IOS_SIMULATOR_ID)}"
    for attempt in 1 2 3; do
      xcrun simctl bootstatus "$IOS_SIMULATOR_ID" -b >/dev/null
      if seen_by_xcode; then
        echo "Simulator $IOS_SIMULATOR_ID booted and listed by Xcode."
        exit 0
      fi
      echo "Xcode does not list $IOS_SIMULATOR_ID (try $attempt of 3); restarting CoreSimulatorService."
      xcrun simctl shutdown all || true
      sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
      sleep 5
      xcrun simctl boot "$IOS_SIMULATOR_ID" || true
    done
    echo "error: Xcode does not list the simulator $IOS_SIMULATOR_ID after three tries" >&2
    xcrun xctrace list devices >&2 || true
    exit 1
    ;;
  *)
    sed -n '4,6s/^# //p' "$0" >&2
    exit 2
    ;;
esac
