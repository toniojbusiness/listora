#!/usr/bin/env bash
# Runs an xcodebuild test command, then runs the tests that failed again, up to twice, each time
# with only those tests, and ends with the summary of every attempt (scripts/ios-test-summary.sh).
# `make ios-ui-test` runs it inside the local stack.
#
# xcodebuild's own -retry-tests-on-failure never retried a UI test here: a failing UI test of a
# class whose `setUp() async throws` sets `continueAfterFailure = false` (every class in
# ListoraUITests) ran once and failed the run (October 2026, Xcode 26 and 27). Re-running the
# failures as a new run retries them whatever XCTest does.
#
# Usage: scripts/ios-test-run.sh <path/to/Result.xcresult> <summary-file or ''> -- <xcodebuild args...>
#
# The args are those of `xcodebuild ... test-without-building`, with the tests to run as
# -only-testing or -skip-testing flags; a re-run replaces those with the failed tests. The
# attempts' bundles are <Result>.xcresult, then <Result>-rerun-1.xcresult and
# <Result>-rerun-2.xcresult. The exit status is the last attempt's.
set -uo pipefail

bundle=${1:?usage: scripts/ios-test-run.sh <Result.xcresult> <summary-file> -- <xcodebuild args...>}
summary_file=${2-}
shift 2
[[ ${1-} == -- ]] && shift
(($# > 0)) || { echo "error: no xcodebuild command" >&2; exit 2; }
command=("$@")
reruns=2

# The tests that failed in a result bundle, as -only-testing flags (target/class/method).
failed_tests() {
  xcrun xcresulttool get test-results tests --path "$1" --compact 2>/dev/null | jq -r '
    def cases(target):
      if .nodeType == "Test Case" then
        select(.result == "Failed") | "-only-testing:\(target)/\(.nodeIdentifier | sub("\\(\\)$"; ""))"
      else
        (if (.nodeType // "" | test("test bundle$")) then .name else target end) as $t
        | .children[]? | cases($t)
      end;
    .testNodes[] | cases("")
  '
}

# The test classes a result bundle has results for, as -only-testing flags (target/class).
ran_classes() {
  xcrun xcresulttool get test-results tests --path "$1" --compact 2>/dev/null | jq -r '
    def suites(target):
      if .nodeType == "Test Suite" and ([.children[]? | select(.nodeType == "Test Case")] | length > 0) then
        "-only-testing:\(target)/\(.name)"
      else
        (if (.nodeType // "" | test("test bundle$")) then .name else target end) as $t
        | .children[]? | suites($t)
      end;
    .testNodes[] | suites("")
  ' | sort -u
}

# The classes the command selects by name (-only-testing:<target>/<class>). A class missing from
# every bundle never ran (the run stopped before it), which must not pass for a success.
selected=$(printf '%s\n' "$@" | grep -E '^-only-testing:[^/]+/[^/]+$' | sort -u)
never_ran() {
  [[ -n $selected ]] || return 0
  local ran
  ran=$(for done_bundle in "${bundles[@]}"; do [[ -d $done_bundle ]] && ran_classes "$done_bundle"; done | sort -u)
  comm -23 <(echo "$selected") <(echo "$ran")
}

rm -rf "$bundle"
"${command[@]}" -resultBundlePath "$bundle"
status=$?
bundles=("$bundle")

# Without the original selection: a re-run runs only the tests that failed.
others=()
for arg in "${command[@]}"; do
  [[ $arg == -only-testing:* || $arg == -skip-testing:* ]] || others+=("$arg")
done

for ((attempt = 1; attempt <= reruns && status != 0; attempt++)); do
  last=${bundles[${#bundles[@]} - 1]}
  [[ -d $last ]] || break # the tests did not start: a build or setup failure, not a test
  tests=$( { failed_tests "$last"; never_ran; } | grep . | sort -u)
  [[ -n $tests ]] || break # failed without a failing test: nothing to re-run
  rerun=${bundle%.xcresult}-rerun-$attempt.xcresult
  IFS=$'\n' read -r -d '' -a selection <<<"$tests"
  echo "Running the tests that failed again (re-run $attempt of $reruns): ${selection[*]//-only-testing:/}"
  rm -rf "$rerun"
  "${others[@]}" "${selection[@]}" -resultBundlePath "$rerun"
  status=$?
  bundles+=("$rerun")
done

scripts/ios-test-summary.sh "$summary_file" "${bundles[@]}"
missing=$(never_ran)
if [[ -n $missing ]]; then
  report="Never ran (the run stopped before them):"$'\n'"  ${missing//$'\n'/$'\n'  }"
  report=${report//-only-testing:/}
  echo "$report"
  [[ -n $summary_file ]] && echo "$report" >>"$summary_file"
  status=1
fi
exit $status
