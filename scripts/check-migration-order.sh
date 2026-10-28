#!/usr/bin/env bash
# Fails when a migration this checkout adds does not sort after every migration of a base commit.
# The migrator never applies a migration that sorts before one already applied
# (docs/architecture.md, Migrations), so a branch whose migration is older than the newest on
# main merges cleanly and then stops every deploy at the migration step.
#
# Usage: scripts/check-migration-order.sh <base-ref>
# CI runs it on every pull request against its base branch, and on every push to main against
# the commit before the push, so two branches that each passed but merged in the wrong order fail
# main's CI (and so its deploy) instead of the live migration step. The fix is always to rename
# the new migration's pair to the current UTC time (`date -u +%Y%m%d%H%M%S`) before it ships.
set -euo pipefail

readonly base=${1:?usage: check-migration-order.sh <base-ref>}
readonly dir=packages/db/migrations

error() {
  # GitHub Actions turns ::error:: lines into annotations; elsewhere they are plain errors.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::error::$*" >&2; else echo "error: $*" >&2; fi
}

# Migration names (`<prefix>_<name>`, without `.up.sql`), sorted as the migrator sorts them.
names_at_base() {
  git ls-tree --name-only "$base" -- "$dir/" | sed -n "s|^$dir/\(.*\)\.up\.sql$|\1|p" | LC_ALL=C sort
}
names_here() {
  find "$dir" -maxdepth 1 -name '*.up.sql' -exec basename {} .up.sql \; | LC_ALL=C sort
}

if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  error "check-migration-order: no commit $base (fetch it first)"
  exit 2
fi

base_names=$(names_at_base)
newest=$(tail -n 1 <<<"$base_names")
added=$(LC_ALL=C comm -13 <(echo "$base_names") <(names_here))

status=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if [[ ! "$name" > "$newest" ]]; then
    error "migration $name sorts before $newest, the newest at $base: rename its pair to the current UTC time (date -u +%Y%m%d%H%M%S)"
    status=1
  fi
done <<<"$added"

if [[ $status -eq 0 ]]; then
  echo "migration order: $(grep -c . <<<"$added" || true) new migration(s), all after $newest"
fi
exit "$status"
