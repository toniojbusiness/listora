#!/usr/bin/env bash
# Smoke test of the application and browser runner images (run by CI; needs Docker and
# `npm ci`).
#
# Builds both images from the root Dockerfile, then runs the schema migration task and starts
# the API, the worker, and the browser runner the way ECS does: read-only root file system
# (with a writable /tmp for the runner), the exact container environment from
# infra/src/containers.ts, and the database password only in PGPASSWORD, against a real
# PostgreSQL 18 that requires that password. Passes when the migrations apply, the runner's
# headless Chromium starts, the API reports ready (database reachable), the worker and the
# runner stay up, and all three stop cleanly on SIGTERM.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly image=listora-app:smoke
readonly runner_image=listora-runner:smoke
readonly network=listora-smoke
readonly password=smoke-only-password
readonly database_url=postgres://listora@listora-smoke-db:5432/listora
readonly containers=(
  listora-smoke-migrate listora-smoke-api listora-smoke-worker listora-smoke-runner-test
  listora-smoke-runner listora-smoke-db
)

workdir=$(mktemp -d)
cleanup() {
  docker rm --force "${containers[@]}" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

fail() {
  echo "container-smoke: $*" >&2
  for container in "${containers[@]}"; do
    echo "--- logs: $container" >&2
    docker logs "$container" >&2 2>&1 || true
  done
  exit 1
}

docker build --tag "$image" .
docker build --target runner --tag "$runner_image" .
docker network create "$network" >/dev/null

# The browser starts in the runner image as the task runs it.
docker run --name listora-smoke-runner-test --read-only --tmpfs /tmp \
  "$runner_image" node apps/worker/src/runner/main.ts self-test >/dev/null ||
  fail "the runner image's browser did not start"
echo "container-smoke: runner browser self-test passed"

docker run --detach --name listora-smoke-db --network "$network" \
  --env POSTGRES_USER=listora --env POSTGRES_PASSWORD="$password" --env POSTGRES_DB=listora \
  postgres:18 >/dev/null
for _ in $(seq 60); do
  # TCP, not the socket: during initialization the server listens on the socket only.
  if docker exec listora-smoke-db pg_isready --host 127.0.0.1 --username listora >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec listora-smoke-db pg_isready --host 127.0.0.1 --username listora >/dev/null ||
  fail "postgres did not start"

for container in migrate api worker runner; do
  PGPASSWORD="$password" node infra/src/container-env.ts "$container" "$database_url" \
    >"$workdir/$container.env"
done

docker run --name listora-smoke-migrate --network "$network" --read-only \
  --env-file "$workdir/migrate.env" \
  "$image" node packages/db/src/cli.ts latest >/dev/null ||
  fail "the schema migration task failed"
echo "container-smoke: migrations applied"

docker run --detach --name listora-smoke-api --network "$network" --read-only \
  --env-file "$workdir/api.env" --publish 127.0.0.1:3000:3000 \
  "$image" node apps/api/src/main.ts >/dev/null
docker run --detach --name listora-smoke-worker --network "$network" --read-only \
  --env-file "$workdir/worker.env" \
  "$image" node apps/worker/src/main.ts >/dev/null
docker run --detach --name listora-smoke-runner --network "$network" --read-only --tmpfs /tmp \
  --env-file "$workdir/runner.env" \
  "$runner_image" node apps/worker/src/runner/main.ts >/dev/null

ready=""
for _ in $(seq 30); do
  if ready=$(curl --silent --fail http://127.0.0.1:3000/health/ready); then break; fi
  sleep 1
done
[[ "$ready" == *'"database":"ok"'* ]] || fail "the API never reported ready: ${ready:-no answer}"
echo "container-smoke: api ready: $ready"

sleep 5
for container in listora-smoke-api listora-smoke-worker listora-smoke-runner; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]] ||
    fail "$container exited early"
  docker stop --time 30 "$container" >/dev/null
  code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
  [[ "$code" == 0 ]] || fail "$container exited with $code on SIGTERM"
done
echo "container-smoke: ok"
