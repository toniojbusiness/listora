#!/usr/bin/env bash
# Runs the operator CLI (`npm run admin`, apps/admin) against a deployed environment's database:
# starts the one-off migration task (`listora-<env>-migrate`, which has the database access) with
# the admin CLI as its command, waits for it to stop, and prints what the CLI printed. The task's
# logs stay in /listora/<env>/migrate. Read commands (activity, sale-why, sale-checks,
# sale-history show) change nothing; `sale-history read` only queues a read-only read.
#
# Usage: scripts/admin-remote.sh <env> [--profile <aws profile>] -- <admin command and options>
# Example: scripts/admin-remote.sh personal --profile prequal-main -- sale-checks
# Uses the ambient AWS credentials and region unless --profile is given. See
# docs/features/activity.md (Searching in AWS).
set -euo pipefail

readonly environment=${1:?usage: admin-remote.sh <env> [--profile <name>] -- <admin args>}
shift
aws_args=()
while [[ $# -gt 0 && "$1" != -- ]]; do
  case "$1" in
    --profile)
      aws_args+=(--profile "${2:?--profile needs a name}")
      shift 2
      ;;
    *)
      echo "error: unknown option $1" >&2
      exit 2
      ;;
  esac
done
if [[ "${1:-}" != -- || $# -lt 2 ]]; then
  echo "usage: admin-remote.sh <env> [--profile <name>] -- <admin args>" >&2
  exit 2
fi
shift

cluster="listora-$environment-migrate"
outputs=$(aws ${aws_args[@]+"${aws_args[@]}"} cloudformation describe-stacks \
  --stack-name "listora-$environment-migrate" --query 'Stacks[0].Outputs' --output json)
output() { jq --raw-output --arg key "$1" '.[] | select(.OutputKey == $key) | .OutputValue' <<<"$outputs"; }
overrides=$(jq --null-input --compact-output '$ARGS.positional as $args
  | {containerOverrides: [{name: "migrate", command: (["node", "apps/admin/src/cli.ts"] + $args)}]}' \
  --args -- "$@")
started=$(aws ${aws_args[@]+"${aws_args[@]}"} ecs run-task --cluster "$cluster" \
  --task-definition "listora-$environment-migrate" --launch-type FARGATE --count 1 \
  --started-by admin-remote \
  --network-configuration "awsvpcConfiguration={subnets=[$(output SubnetIds)],securityGroups=[$(output SecurityGroupId)],assignPublicIp=$(output AssignPublicIp)}" \
  --overrides "$overrides" --output json)
task=$(jq --raw-output '.tasks[0].taskArn // empty' <<<"$started")
if [[ -z "$task" ]]; then
  echo "error: the admin task did not start: $(jq --compact-output '.failures' <<<"$started")" >&2
  exit 1
fi
id=${task##*/}
echo "admin task $id" >&2
while true; do
  status=$(aws ${aws_args[@]+"${aws_args[@]}"} ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].lastStatus' --output text)
  [[ "$status" == STOPPED ]] && break
  sleep 5
done
code=$(aws ${aws_args[@]+"${aws_args[@]}"} ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
# The CLI's results went to stdout and its structured events to stderr; both are in the log.
aws ${aws_args[@]+"${aws_args[@]}"} logs filter-log-events --log-group-name "/listora/$environment/migrate" \
  --log-stream-name-prefix "migrate/migrate/$id" --query 'events[].message' --output json |
  jq --raw-output '.[]'
if [[ "$code" != 0 ]]; then
  echo "error: the admin CLI exited with $code" >&2
  exit 1
fi
