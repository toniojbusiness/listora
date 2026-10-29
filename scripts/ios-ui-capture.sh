#!/usr/bin/env bash
# Sets how the UI tests capture the screen, in the .xctestrun the tests run from: `screenshots`
# (the default of `make ios-ui-test`) or `screenRecording`. Xcode records a video of every UI test
# by default, and encoding it competes for the CPU with the simulator, the app, and the local
# stack on CI's three-core runners, where the API then answered in seconds. Screenshots of each
# step stay in the result bundle either way.
#
# Usage: scripts/ios-ui-capture.sh <screenshots|screenRecording> <path/to/Tests.xctestrun>
set -euo pipefail

format=${1:?usage: scripts/ios-ui-capture.sh <screenshots|screenRecording> <xctestrun>}
xctestrun=${2:?usage: scripts/ios-ui-capture.sh <screenshots|screenRecording> <xctestrun>}
[[ $format == screenshots || $format == screenRecording ]] ||
  { echo "error: the capture format is screenshots or screenRecording, not '$format'" >&2; exit 2; }
[[ -f $xctestrun ]] || { echo "error: no xctestrun at $xctestrun" >&2; exit 2; }

buddy=/usr/libexec/PlistBuddy
set_format() { # <key path of a test target>
  "$buddy" -c "Delete $1:PreferredScreenCaptureFormat" "$xctestrun" >/dev/null 2>&1 || true
  "$buddy" -c "Add $1:PreferredScreenCaptureFormat string $format" "$xctestrun"
}
# Format 2 files list their targets under each test configuration.
for ((config = 0; ; config++)); do
  "$buddy" -c "Print :TestConfigurations:$config" "$xctestrun" >/dev/null 2>&1 || break
  for ((target = 0; ; target++)); do
    path=":TestConfigurations:$config:TestTargets:$target"
    name=$("$buddy" -c "Print $path:BlueprintName" "$xctestrun" 2>/dev/null) || break
    [[ $name == ListoraUITests ]] && set_format "$path"
  done
done
