#!/usr/bin/env bash
# Prints which tests failed, and which passed only on a retry (flaky), from an xcodebuild result
# bundle. `make ios-test` runs it after the tests; the CI iOS job also writes it to the job summary.
#
# Usage: scripts/ios-test-summary.sh <path/to/Test.xcresult> [summary-file]
#
# The optional summary file is rewritten with the same text. The script exits 0 whatever the
# tests did: the test command's own exit status decides the result.
set -uo pipefail

bundle=${1:?usage: scripts/ios-test-summary.sh <path/to/Test.xcresult> [summary-file]}
summary_file=${2:-}
if [[ -n $summary_file ]]; then : >"$summary_file"; fi

report() {
  echo "$1"
  if [[ -n $summary_file ]]; then echo "$1" >>"$summary_file"; fi
}

if [[ ! -d $bundle ]]; then
  report "No test results at $bundle: the tests did not start (see the build output above)."
  exit 0
fi

if ! tests_json=$(xcrun xcresulttool get test-results tests --path "$bundle" --compact 2>&1); then
  report "Could not read $bundle: $tests_json"
  exit 0
fi

# Every test case with its suite, its final result, its failure messages, and whether any of
# its repetitions failed (a retry that then passed). Tab-separated: result, flaky, suite/name, messages.
cases=$(jq -r '
  def cases(suite):
    if .nodeType == "Test Case" then
      [ .result,
        ([.children[]? | select(.nodeType == "Repetition" and .result == "Failed")] | length > 0),
        "\(suite)/\(.name)",
        ([.. | objects | select(.nodeType? == "Failure Message") | .name] | unique | join(" | "))
      ] | @tsv
    else
      .name as $name | (if .nodeType == "Test Suite" then $name else suite end) as $s
      | .children[]? | cases($s)
    end;
  .testNodes[] | cases("")
' <<<"$tests_json")

failed=$(awk -F '\t' '$1 == "Failed" { print "  " $3 (length($4) ? " - " $4 : "") }' <<<"$cases")
flaky=$(awk -F '\t' '$1 == "Passed" && $2 == "true" { print "  " $3 }' <<<"$cases")
total=$(grep -c . <<<"$cases")

report ""
report "iOS test summary ($total tests, results in $bundle):"
if [[ -n $failed ]]; then
  report "Failed after every retry:"
  report "$failed"
else
  report "No test failed."
fi
if [[ -n $flaky ]]; then
  report "Flaky (failed, then passed on a retry; fix these in a follow-up):"
  report "$flaky"
fi
exit 0
