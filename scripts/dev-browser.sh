#!/usr/bin/env bash
# Installs the headless Chromium that the browser runner and its tests use, at the version
# playwright-core pins, into this checkout's .local/playwright (or PLAYWRIGHT_BROWSERS_PATH, if
# set; the runner reads the same variable). Safe to run again: an installed browser is kept.
#
#   scripts/dev-browser.sh              # the browser only
#   scripts/dev-browser.sh --with-deps  # also its system libraries (Linux CI; uses sudo)
set -euo pipefail

cd "$(dirname "$0")/.."
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.local/playwright}"
exec npx playwright-core install --only-shell --no-progress "$@" chromium
