#!/usr/bin/env bash
# Prints which tests failed, and which passed only on a retry (flaky), from the result bundles of
# one test run and its re-runs of the failed tests (scripts/ios-test-run.sh), in order. `make
# ios-unit-test`, `make ios-ui-test`, and `make e2e-full` run it after the tests; the CI iOS jobs
# also write it to their job summaries.
#
# Usage: scripts/ios-test-summary.sh <summary-file or ''> <path/to/Test.xcresult>...
#
# A test's result is its result in the last bundle that ran it. It is flaky when it passed there
# but failed before: in an earlier bundle, or in an earlier repetition of xcodebuild's own
# -retry-tests-on-failure. The optional summary file is rewritten with the same text. The script
# exits 0 whatever the tests did: the test command's own exit status decides the result.
set -uo pipefail

usage='usage: scripts/ios-test-summary.sh <summary-file or '"''"'> <path/to/Test.xcresult>...'
summary_file=${1?$usage}
shift
(($# > 0)) || { echo "$usage" >&2; exit 2; }
if [[ -n $summary_file ]]; then : >"$summary_file"; fi

report() {
  echo "$1"
  if [[ -n $summary_file ]]; then echo "$1" >>"$summary_file"; fi
}

first=$1
if [[ ! -d $first ]]; then
  report "No test results at $first: the tests did not start (see the build output above)."
  exit 0
fi

# Every test case of every bundle with its suite, its result, its failure messages, and whether
# any of its repetitions failed. Tab-separated: attempt, result, failed before, suite/name,
# messages.
cases=
attempt=0
for bundle in "$@"; do
  attempt=$((attempt + 1))
  [[ -d $bundle ]] || continue
  if ! tests_json=$(xcrun xcresulttool get test-results tests --path "$bundle" --compact 2>&1); then
    report "Could not read $bundle: $tests_json"
    exit 0
  fi
  cases+=$(jq -r --argjson attempt "$attempt" '
    def cases(suite):
      if .nodeType == "Test Case" then
        [ $attempt,
          .result,
          ([.children[]? | select(.nodeType == "Repetition" and .result == "Failed")] | length > 0),
          "\(suite)/\(.name)",
          ([.. | objects | select(.nodeType? == "Failure Message") | .name] | unique | join(" | "))
        ] | @tsv
      else
        .name as $name | (if .nodeType == "Test Suite" then $name else suite end) as $s
        | .children[]? | cases($s)
      end;
    .testNodes[] | cases("")
  ' <<<"$tests_json")$'\n'
done

# One line per test: its last result, whether it ever failed before that, and that last run's
# failure messages.
tests=$(awk -F '\t' '
  NF >= 4 {
    name = $4
    if (!(name in result)) order[++n] = name
    else if (result[name] == "Failed") failed_before[name] = 1
    result[name] = $2; messages[name] = $5
    if ($3 == "true") failed_before[name] = 1
  }
  END { for (i = 1; i <= n; i++) { t = order[i]; print result[t] "\t" (t in failed_before) "\t" t "\t" messages[t] } }
' <<<"$cases")

failed=$(awk -F '\t' '$1 == "Failed" { print "  " $3 (length($4) ? " - " $4 : "") }' <<<"$tests")
flaky=$(awk -F '\t' '$1 == "Passed" && $2 == "1" { print "  " $3 }' <<<"$tests")
total=$(grep -c . <<<"$tests")
reruns=$(($# - 1))

report ""
report "iOS test summary ($total tests, results in $first$( ((reruns > 0)) && echo " and its re-runs")):"
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
