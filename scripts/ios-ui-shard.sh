#!/usr/bin/env bash
# Splits the UI test classes (apps/ios/ListoraUITests) into shards of about equal running time,
# so CI runs them side by side on separate macOS runners, each with its own local stack
# (`make ios-ui-test IOS_UI_SHARD=<shard>/<count>`; the CI section of README.md).
#
#   scripts/ios-ui-shard.sh <shard> <count>    # the -only-testing flags of one shard (1-based)
#   scripts/ios-ui-shard.sh plan <count>       # every shard's classes and estimated seconds
#   scripts/ios-ui-shard.sh seconds <xcresult> # each class's seconds in a result bundle
#
# A class's time comes from scripts/ios-ui-test-seconds.tsv (class, tab, seconds), recorded from
# a CI run: `scripts/ios-ui-shard.sh seconds <Test.xcresult>` prints a fresh copy. A class missing
# from it counts as the median, so a new class still runs; a stale time only unbalances the
# shards. The split is deterministic: the longest class first, each to the shard with the least
# time so far, so every class runs in exactly one shard.
set -euo pipefail

cd "$(dirname "$0")/.."
seconds_file=scripts/ios-ui-test-seconds.tsv
tests_dir=apps/ios/ListoraUITests

usage() {
  sed -n '6,8s/^# //p' "$0" >&2
  exit 2
}

# Every XCTestCase subclass in the UI test target, one name per line, sorted.
classes() {
  find "$tests_dir" -name '*.swift' -print0 |
    xargs -0 sed -nE 's/^[[:space:]]*(final[[:space:]]+)?class[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*XCTestCase.*/\2/p' |
    sort -u
}

# "<shard>\t<seconds>\t<class>" for every class, for <count> shards.
assign() {
  local count=$1
  classes | awk -F '\t' -v count="$count" '
    FNR == NR { known[$1] = $2; times[++n] = $2; next }
    { names[++m] = $1 }
    END {
      if (m == 0) { print "error: no UI test classes found" > "/dev/stderr"; exit 1 }
      # The median recorded time, for a class with none.
      asort_times(times, n)
      median = n ? times[int((n + 1) / 2)] : 60
      for (i = 1; i <= m; i++) {
        name = names[i]
        weight[name] = (name in known) ? known[name] : median
      }
      # Longest first; equal times by name, so the split never depends on the input order.
      for (i = 1; i <= m; i++) order[i] = names[i]
      for (i = 2; i <= m; i++) {
        key = order[i]
        for (j = i - 1; j >= 1 && before(key, order[j]); j--) order[j + 1] = order[j]
        order[j + 1] = key
      }
      for (s = 1; s <= count; s++) load[s] = 0
      for (i = 1; i <= m; i++) {
        best = 1
        for (s = 2; s <= count; s++) if (load[s] < load[best]) best = s
        load[best] += weight[order[i]]
        printf "%d\t%d\t%s\n", best, weight[order[i]], order[i]
      }
    }
    function before(a, b) { return weight[a] > weight[b] || (weight[a] == weight[b] && a < b) }
    function asort_times(t, len,   i, j, v) {
      for (i = 2; i <= len; i++) {
        v = t[i]
        for (j = i - 1; j >= 1 && t[j] + 0 > v + 0; j--) t[j + 1] = t[j]
        t[j + 1] = v
      }
    }
  ' "$seconds_file" -
}

require_count() {
  [[ $1 =~ ^[1-9][0-9]*$ ]] || { echo "error: the shard count must be a positive number, not '$1'" >&2; exit 2; }
}

case "${1:-}" in
  plan)
    count=${2:-}
    require_count "$count"
    assign "$count" | sort -t $'\t' -k1,1n -k2,2nr -k3,3 |
      awk -F '\t' '
        $1 != shard { if (shard) printf "  total %ds\n", total; shard = $1; total = 0; printf "shard %d:\n", shard }
        { total += $2; printf "  %5ds %s\n", $2, $3 }
        END { if (shard) printf "  total %ds\n", total }
      '
    ;;
  seconds)
    bundle=${2:-}
    [[ -d $bundle ]] || usage
    xcrun xcresulttool get test-results tests --path "$bundle" --compact | jq -r '
      def cases(suite):
        if .nodeType == "Test Case" then [suite, (.durationInSeconds // 0)]
        else (if .nodeType == "Test Suite" then .name else suite end) as $s | .children[]? | cases($s)
        end;
      [.testNodes[] | .. | objects | select(.nodeType? == "UI test bundle") | cases("")]
      | group_by(.[0]) | map("\(.[0][0])\t\(map(.[1]) | add | round)") | .[]
    '
    ;;
  '' | -h | --help) usage ;;
  *)
    shard=$1 count=${2:-}
    require_count "$count"
    if ! [[ $shard =~ ^[1-9][0-9]*$ ]] || ((shard > count)); then
      echo "error: the shard must be 1 to $count, not '$shard'" >&2
      exit 2
    fi
    assign "$count" | awk -F '\t' -v shard="$shard" '$1 == shard { print "-only-testing:ListoraUITests/" $3 }' | sort
    ;;
esac
