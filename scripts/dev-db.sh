#!/usr/bin/env bash
# Local PostgreSQL 18 for Listora development and integration tests.
#
# The cluster lives in <repo>/.local/pg (gitignored), listens only on 127.0.0.1, and is owned by
# this checkout, so several worktrees can each run their own cluster on different ports.
#
# Usage: scripts/dev-db.sh [start|stop|reset|status|url [dev|test]|psql [dev|test]]
#   start   (default) initialize the cluster if needed, start it, ensure both databases exist
#   stop    stop the cluster if it is running
#   reset   stop and delete the cluster, then start a fresh one (all local data is lost)
#   status  print whether the cluster is running and on which port
#   url     print the connection URL for the dev (default) or test database
#   psql    open psql on the dev (default) or test database
#
# Configuration (environment variable, else a LISTORA_PG_PORT= line in <repo>/.env):
#   LISTORA_PG_PORT  TCP port (default 55432; keep in sync with packages/testing/src/database-url.ts)
#   PG_BIN_DIR       directory with PostgreSQL 18 binaries (default: Homebrew postgresql@18)
#
# Every command is idempotent: running start twice, or stop when stopped, succeeds.
set -euo pipefail

readonly PG_MAJOR=18
readonly DEFAULT_PORT=55432
readonly DB_USER=listora
readonly DEV_DB=listora
readonly TEST_DB=listora_test

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ROOT
readonly PG_HOME="$ROOT/.local/pg"
readonly DATA_DIR="$PG_HOME/data"
readonly LOG_FILE="$PG_HOME/server.log"

log() { printf 'dev-db: %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

resolve_port() {
  local port="${LISTORA_PG_PORT:-}"
  if [[ -z "$port" && -f "$ROOT/.env" ]]; then
    # Read only this key; never source .env, which may hold unrelated secrets.
    port="$(sed -n 's/^[[:space:]]*LISTORA_PG_PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$ROOT/.env" | tail -n 1)"
  fi
  port="${port:-$DEFAULT_PORT}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
    die "LISTORA_PG_PORT must be an integer from 1024 to 65535, got '$port'"
  fi
  printf '%s' "$port"
}

resolve_bin_dir() {
  if [[ -n "${PG_BIN_DIR:-}" ]]; then
    printf '%s' "$PG_BIN_DIR"
    return
  fi
  command -v brew >/dev/null 2>&1 ||
    die "PostgreSQL $PG_MAJOR not found: install Homebrew, or set PG_BIN_DIR to its bin directory"
  local prefix
  prefix="$(brew --prefix "postgresql@$PG_MAJOR")"
  if [[ ! -x "$prefix/bin/postgres" ]]; then
    log "installing postgresql@$PG_MAJOR with Homebrew"
    # Run from a scratch directory: some formula post-install steps write relative paths
    # into the current directory, which must not be this repository.
    (cd "$(mktemp -d)" && brew install "postgresql@$PG_MAJOR") ||
      log "brew reported an error; checking whether the binaries were installed anyway"
  fi
  printf '%s' "$prefix/bin"
}

PORT="$(resolve_port)"
readonly PORT

pg() {
  local tool="$1"
  shift
  "$BIN_DIR/$tool" "$@"
}

init_bin_dir() {
  BIN_DIR="$(resolve_bin_dir)"
  [[ -x "$BIN_DIR/postgres" ]] || die "no postgres binary in $BIN_DIR"
  local version
  version="$(pg postgres --version)"
  [[ "$version" =~ \(PostgreSQL\)\ $PG_MAJOR\. ]] ||
    die "expected PostgreSQL $PG_MAJOR, found: $version"
  # An interrupted Homebrew post-install leaves the binaries without their share files.
  local share_dir
  share_dir="$(pg pg_config --sharedir)"
  [[ -f "$share_dir/postgres.bki" ]] ||
    die "PostgreSQL install is incomplete ($share_dir is missing); run 'brew postinstall postgresql@$PG_MAJOR'"
}

is_running() {
  [[ -f "$DATA_DIR/PG_VERSION" ]] && pg pg_ctl status -D "$DATA_DIR" >/dev/null 2>&1
}

running_port() {
  sed -n '4p' "$DATA_DIR/postmaster.pid" 2>/dev/null || true
}

db_url() {
  local db="$1"
  printf 'postgres://%s@127.0.0.1:%s/%s' "$DB_USER" "$PORT" "$db"
}

ensure_database() {
  local db="$1" exists
  exists="$(pg psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d postgres -tAc \
    "select 1 from pg_database where datname = '$db'")"
  if [[ "$exists" != "1" ]]; then
    pg createdb -h 127.0.0.1 -p "$PORT" -U "$DB_USER" "$db"
    log "created database $db"
  fi
}

cmd_start() {
  init_bin_dir
  mkdir -p "$PG_HOME"

  if [[ -f "$DATA_DIR/PG_VERSION" && "$(cat "$DATA_DIR/PG_VERSION")" != "$PG_MAJOR" ]]; then
    die "cluster in $DATA_DIR is PostgreSQL $(cat "$DATA_DIR/PG_VERSION"); run 'scripts/dev-db.sh reset'"
  fi

  if is_running; then
    local current
    current="$(running_port)"
    [[ "$current" == "$PORT" ]] ||
      die "cluster is already running on port $current, not $PORT; run 'scripts/dev-db.sh stop' first"
    log "already running on port $PORT"
  else
    if pg pg_isready -q -h 127.0.0.1 -p "$PORT" -t 2; then
      die "port $PORT is used by another PostgreSQL server; set LISTORA_PG_PORT to a free port"
    fi
    if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
      log "initializing cluster in $DATA_DIR"
      # Trust auth is acceptable only because the server listens on loopback TCP alone.
      pg initdb -D "$DATA_DIR" -U "$DB_USER" --auth=trust --encoding=UTF8 --locale=C >/dev/null
    fi
    log "starting on 127.0.0.1:$PORT (log: $LOG_FILE)"
    LC_ALL=C pg pg_ctl start -D "$DATA_DIR" -l "$LOG_FILE" -w -t 30 \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" >/dev/null ||
      die "server failed to start; see $LOG_FILE"
  fi

  ensure_database "$DEV_DB"
  ensure_database "$TEST_DB"
  log "ready: $(db_url "$DEV_DB") (tests: $(db_url "$TEST_DB"))"
}

cmd_stop() {
  init_bin_dir
  if is_running; then
    pg pg_ctl stop -D "$DATA_DIR" -m fast -w >/dev/null
    log "stopped"
  else
    log "not running"
  fi
}

cmd_reset() {
  cmd_stop
  # Guard the recursive delete: only ever the cluster directory inside this repository.
  [[ "$PG_HOME" == "$ROOT/.local/pg" && -n "$ROOT" ]] || die "refusing to delete $PG_HOME"
  rm -rf "$PG_HOME"
  log "deleted $PG_HOME"
  cmd_start
}

cmd_status() {
  init_bin_dir
  if is_running; then
    printf 'running on 127.0.0.1:%s (data: %s)\n' "$(running_port)" "$DATA_DIR"
  elif [[ -f "$DATA_DIR/PG_VERSION" ]]; then
    printf 'stopped (data: %s)\n' "$DATA_DIR"
    return 3
  else
    printf 'not initialized (run scripts/dev-db.sh start)\n'
    return 3
  fi
}

database_for() {
  case "${1:-dev}" in
    dev) printf '%s' "$DEV_DB" ;;
    test) printf '%s' "$TEST_DB" ;;
    *) die "unknown database '$1' (expected dev or test)" ;;
  esac
}

main() {
  local command="${1:-start}"
  case "$command" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    reset) cmd_reset ;;
    status) cmd_status ;;
    url) printf '%s\n' "$(db_url "$(database_for "${2:-dev}")")" ;;
    psql)
      init_bin_dir
      exec "$BIN_DIR/psql" "$(db_url "$(database_for "${2:-dev}")")"
      ;;
    -h | --help | help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
    *) die "unknown command '$command' (try --help)" ;;
  esac
}

main "$@"
