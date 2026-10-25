#!/usr/bin/env bash
# Runs the schema migrations of one deployed environment: starts the one-off migration task
# (`listora-<env>-migrate`, from the migrate stack) and waits for it to stop. Exits 0 only when
# the task's container exited 0, so a deploy that runs this stops on a failed migration before
# any new service task starts. Its logs are in /listora/<env>/migrate.
#
# Usage: scripts/run-migrations.sh <env> [started-by]
# Uses the ambient AWS credentials and region. Run by .github/workflows/deploy.yml and
# scripts/deploy-personal.sh; see infra/README.md (Schema migrations).
set -euo pipefail

readonly environment=${1:?usage: run-migrations.sh <env> [started-by]}
readonly started_by=${2:-deploy-${GITHUB_RUN_ID:-local}}

error() {
  # GitHub Actions turns ::error:: lines into annotations; elsewhere they are plain errors.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::error::$*" >&2; else echo "error: $*" >&2; fi
}

cluster="listora-$environment-migrate"
outputs=$(aws cloudformation describe-stacks --stack-name "listora-$environment-migrate" \
  --query 'Stacks[0].Outputs' --output json)
output() { jq --raw-output --arg key "$1" '.[] | select(.OutputKey == $key) | .OutputValue' <<<"$outputs"; }
subnets=$(output SubnetIds)
group=$(output SecurityGroupId)
# The stack says whether the task needs a public address (public-IP egress, no NAT).
public_ip=$(output AssignPublicIp)
started=$(aws ecs run-task --cluster "$cluster" --task-definition "listora-$environment-migrate" \
  --launch-type FARGATE --count 1 --started-by "$started_by" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=$public_ip}" \
  --output json)
task=$(jq --raw-output '.tasks[0].taskArn // empty' <<<"$started")
if [[ -z "$task" ]]; then
  error "The schema migration task did not start: $(jq --compact-output '.failures' <<<"$started")"
  exit 1
fi
echo "Schema migration task $task"
# No fixed wait limit: a long migration runs until it stops, bounded by the caller's timeout.
while true; do
  stopped=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
  status=$(jq --raw-output '.tasks[0].lastStatus // "MISSING"' <<<"$stopped")
  if [[ "$status" == STOPPED ]]; then break; fi
  if [[ "$status" == MISSING ]]; then
    error "The schema migration task disappeared: $(jq --compact-output '.failures' <<<"$stopped")"
    exit 1
  fi
  sleep 15
done
code=$(jq --raw-output '.tasks[0].containers[0].exitCode // "none"' <<<"$stopped")
if [[ "$code" != 0 ]]; then
  error "Schema migrations failed (exit code $code): $(jq --raw-output '.tasks[0].stoppedReason // ""' <<<"$stopped")"
  error "The task's logs are in /listora/$environment/migrate."
  exit 1
fi
echo "Schema migrations applied"
