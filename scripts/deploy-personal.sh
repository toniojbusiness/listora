#!/usr/bin/env bash
# One-command deploy of the personal environment (infra/README.md, Deploying the personal
# environment). Run from a clean checkout of the commit to deploy; the image is tagged with it.
#
# Usage: scripts/deploy-personal.sh --profile <aws profile> [--code-only] [--dry-run]
#                                   [--anthropic-env <file>]
#
#   --profile        AWS CLI profile of the personal account (or AWS_PROFILE). Passed to every
#                    aws and cdk command; the script never exports credentials.
#   --code-only      The fast path, for a commit that changes no infrastructure: build and push
#                    the images, run the migrations only when there are new ones, and move the
#                    services to the new images directly, without CloudFormation. It first
#                    compares every synthesized template, the execution policy, and the
#                    Anthropic key with what is deployed, and refuses (changing nothing) when
#                    anything differs: that needs the full deploy.
#   --dry-run        Run every offline check (tools, synthesis with the real settings, the
#                    restricted execution policy, template invariants) and print each step
#                    and command without calling AWS.
#   --anthropic-env  File with the ANTHROPIC_API_KEY=... line (default
#                    ~/.config/listora/anthropic.env). The key is never printed.
#
# Required, from the environment: LISTORA_OWNER_EMAIL, the address the owner signs in to the app
# with (the user pool's only user; docs/features/auth.md).
#
# Optional settings, from the environment (.env.example): LISTORA_AWS_REGION (us-east-1),
# LISTORA_AVAILABILITY_ZONES, LISTORA_ALARM_EMAIL, LISTORA_DOMAIN with LISTORA_HOSTED_ZONE_ID,
# and LISTORA_CONTAINER_CLI (docker).
#
# Steps: verify the account; check the zones and the existing stacks; synthesize offline; make
# sure the restricted CDK bootstrap is in place (create its execution policy and bootstrap if
# the account has none, refuse if it has another); deploy the registry; build and push the
# image; deploy the state stacks and the migration task; wait until SES has verified the
# owner's address (the first deploy emails them a link to click); deploy the user pool; store
# the Anthropic key; run the migrations; deploy the services and alarms; wait for health; run
# the smoke test; print the API URL and the iPhone app's sign-in settings. It never deletes or
# replaces anything that already exists: a stack in a failed state or a bootstrap it did not
# make stops it with the reason. With --code-only, the steps after the bootstrap check are:
# compare with what is deployed; build and push the images; run the migrations if the commit
# adds any; register task definition revisions with the new images and move the services to
# them; then the same health wait and smoke test.
set -euo pipefail

# The captain's personal AWS account. Deploying anywhere else is refused.
readonly EXPECTED_ACCOUNT=976033325938
readonly ENVIRONMENT=personal

cd "$(dirname "${BASH_SOURCE[0]}")/.."
readonly ASSEMBLY=cdk.out/deploy-$ENVIRONMENT
# The schema migrations the image carries (docs/architecture.md, Migrations).
readonly MIGRATIONS=packages/db/migrations

dry_run=false
code_only=false
profile=${AWS_PROFILE:-}
anthropic_env="$HOME/.config/listora/anthropic.env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --code-only) code_only=true ;;
    --profile)
      profile=${2:?--profile needs a value}
      shift
      ;;
    --anthropic-env)
      anthropic_env=${2:?--anthropic-env needs a value}
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "deploy-personal: unknown argument $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

readonly region=${LISTORA_AWS_REGION:-us-east-1}
readonly container_cli=${LISTORA_CONTAINER_CLI:-docker}
readonly policy_name="listora-$ENVIRONMENT-cdk-execution"
readonly policy_arn="arn:aws:iam::$EXPECTED_ACCOUNT:policy/$policy_name"
readonly registry="$EXPECTED_ACCOUNT.dkr.ecr.$region.amazonaws.com"
readonly api_log_group="/listora/$ENVIRONMENT/api"
readonly stacks=(registry network secrets data storage email auth migrate compute observability)
owner_email=$(tr '[:upper:]' '[:lower:]' <<<"${LISTORA_OWNER_EMAIL:-}")
readonly owner_email
readonly code_only

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

step_number=0
step() {
  step_number=$((step_number + 1))
  printf '\n==> %d. %s\n' "$step_number" "$*"
}
info() { printf '    %s\n' "$*"; }
would() { printf '    would run: %s\n' "$*"; }
fail() {
  printf '\ndeploy-personal: FAILED: %s\n' "$*" >&2
  exit 1
}

# Every AWS call names the profile and region; nothing is exported.
aws_() { aws --profile "$profile" --region "$region" "$@"; }
# cdk reads an SSO profile's cached access token, which lasts about an hour, and cannot renew
# it, while the AWS CLI keeps working from its own cached role credentials. So cdk gets its
# credentials from the CLI: a private AWS config in the work directory (removed on exit) holds
# one profile whose credential_process asks the CLI for the profile's credentials. Nothing is
# exported or written to disk but that config, which holds no credentials.
readonly cdk_profile=listora-deploy-cdk
cdk_config() {
  local source_config=${AWS_CONFIG_FILE:-$HOME/.aws/config}
  (umask 077 && printf '[profile %s]\ncredential_process = env AWS_CONFIG_FILE="%s" aws configure export-credentials --profile %s --format process\nregion = %s\n' \
    "$cdk_profile" "$source_config" "$profile" "$region" >"$workdir/aws-config")
}
cdk_() {
  aws_ sts get-caller-identity >/dev/null ||
    fail "the sign-in of profile $profile has expired; run aws sso login --profile $profile and run this again"
  [[ -e "$workdir/aws-config" ]] || cdk_config
  (cd infra && AWS_CONFIG_FILE="$workdir/aws-config" npx cdk "$@" --profile "$cdk_profile" --no-notices --no-version-reporting)
}

# --- 1. Local checks --------------------------------------------------------------------------
step "Local checks"
for tool in node npx jq aws git; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
if [[ "$dry_run" == false ]]; then
  [[ -n "$profile" ]] || fail "name the AWS profile of account $EXPECTED_ACCOUNT with --profile"
  command -v "$container_cli" >/dev/null ||
    fail "$container_cli is not installed (or set LISTORA_CONTAINER_CLI)"
  "$container_cli" info >/dev/null 2>&1 || fail "$container_cli is not running"
fi
dirty=$(git status --porcelain)
if [[ -n "$dirty" ]]; then
  [[ "$dry_run" == true ]] || fail "the checkout has uncommitted changes; the image tag must name the deployed code"
  info "warning: uncommitted changes (a real deploy refuses this)"
fi
image_tag=$(git rev-parse HEAD)
readonly image_tag
info "commit $image_tag, region $region, profile ${profile:-(none)}"

[[ -n "$owner_email" ]] ||
  fail "set LISTORA_OWNER_EMAIL to the email address you sign in to the app with (the only account the deployed app accepts)"
info "owner (the only person who can sign in): $owner_email"

[[ -r "$anthropic_env" ]] || fail "no Anthropic key file at $anthropic_env"
anthropic_key=$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$anthropic_env" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
[[ -n "$anthropic_key" ]] || fail "$anthropic_env has no ANTHROPIC_API_KEY= line"
info "Anthropic key found in $anthropic_env (${#anthropic_key} characters, not shown)"

# --- 2. Account ------------------------------------------------------------------------------
step "Verify the AWS account is $EXPECTED_ACCOUNT"
if [[ "$dry_run" == true ]]; then
  would "aws sts get-caller-identity --profile ${profile:-<profile>}  (refuse unless $EXPECTED_ACCOUNT)"
else
  account=$(aws_ sts get-caller-identity --query Account --output text) ||
    fail "cannot read the identity of profile $profile (sign in first, for example aws sso login --profile $profile)"
  [[ "$account" == "$EXPECTED_ACCOUNT" ]] ||
    fail "profile $profile is account $account, not $EXPECTED_ACCOUNT; refusing to deploy"
  info "profile $profile is account $account"
fi

# --- 3. Zones and existing stacks ------------------------------------------------------------
step "Check the availability zones and the existing stacks"
zones=${LISTORA_AVAILABILITY_ZONES:-}
compute_existed=false
# The email stack creates the owner's SES identity unless the account already has one that no
# Listora stack owns (CloudFormation refuses to create an identity that exists, and the script
# never takes over or changes a resource it did not make).
owner_identity=${LISTORA_OWNER_EMAIL_IDENTITY:-create}
if [[ "$dry_run" == true ]]; then
  would "aws ec2 describe-availability-zones  (refuse a zone without API Gateway VPC links, use1-az3)"
  would "aws sesv2 get-email-identity --email-identity $owner_email  (an identity no Listora stack owns is left alone: ownerEmailIdentity=existing)"
  would "aws cloudformation describe-stacks --stack-name listora-$ENVIRONMENT-<each stack>  (refuse a failed or busy stack)"
else
  zone_table=$(aws_ ec2 describe-availability-zones --filters Name=state,Values=available \
    --query 'AvailabilityZones[].[ZoneName,ZoneId]' --output text)
  if [[ -z "$zones" ]]; then
    first_two=$(head -n 2 <<<"$zone_table")
    if grep -q 'use1-az3' <<<"$first_two"; then
      suggestion=$(awk '$2 != "use1-az3" { print $1 }' <<<"$zone_table" | head -n 2 | paste -sd, -)
      fail "the region's first two zones include use1-az3, which has no API Gateway VPC links; set LISTORA_AVAILABILITY_ZONES=$suggestion (and keep it for every later deploy)"
    fi
    info "zones: the region's first two ($(awk '{ print $1 "=" $2 }' <<<"$first_two" | paste -sd' ' -))"
  else
    for zone in ${zones//,/ }; do
      id=$(awk -v name="$zone" '$1 == name { print $2 }' <<<"$zone_table")
      [[ -n "$id" ]] || fail "zone $zone is not an available zone of $region"
      [[ "$id" != use1-az3 ]] || fail "zone $zone is use1-az3, which has no API Gateway VPC links"
    done
    info "zones: $zones"
  fi
  for name in "${stacks[@]}"; do
    stack="listora-$ENVIRONMENT-$name"
    if ! described=$(aws_ cloudformation describe-stacks --stack-name "$stack" --output json 2>"$workdir/err"); then
      grep -q 'does not exist' "$workdir/err" || fail "cannot describe $stack: $(cat "$workdir/err")"
      [[ "$code_only" == false ]] ||
        fail "$stack does not exist yet, so --code-only has nothing to update; deploy in full (without --code-only)"
      continue
    fi
    status=$(jq -r '.Stacks[0].StackStatus' <<<"$described")
    case "$status" in
      *_IN_PROGRESS) fail "$stack is $status; wait for it to finish, then run this again" ;;
      ROLLBACK_COMPLETE | *_FAILED)
        fail "$stack is $status and needs a person to look at it (infra/README.md, Rollback); nothing was changed"
        ;;
    esac
    [[ "$name" != compute ]] || compute_existed=true
    info "$stack: $status"
  done
  if aws_ sesv2 get-email-identity --email-identity "$owner_email" >/dev/null 2>"$workdir/err"; then
    owned=$(aws_ cloudformation list-stack-resources --stack-name "listora-$ENVIRONMENT-email" \
      --query "StackResourceSummaries[?ResourceType=='AWS::SES::EmailIdentity'].PhysicalResourceId" \
      --output text 2>/dev/null || true)
    if grep -qx "$owner_email" <<<"${owned//$'\t'/$'\n'}"; then
      owner_identity=create
      info "SES identity $owner_email: managed by listora-$ENVIRONMENT-email"
    else
      owner_identity=existing
      info "SES identity $owner_email: already in the account outside Listora's stacks; left alone"
    fi
  else
    grep -q 'NotFoundException' "$workdir/err" || fail "cannot read the SES identity $owner_email: $(cat "$workdir/err")"
  fi
fi

# --- 4. Offline synthesis and template checks ------------------------------------------------
step "Synthesize the stacks offline with the real settings"
context=(--context "env=$ENVIRONMENT" --context "account=$EXPECTED_ACCOUNT" --context "region=$region"
  --context "imageTag=$image_tag" --context "ownerEmail=$owner_email"
  --context "ownerEmailIdentity=$owner_identity")
[[ -z "$zones" ]] || context+=(--context "availabilityZones=$zones")
[[ -z "${LISTORA_ALARM_EMAIL:-}" ]] || context+=(--context "alarmEmail=$LISTORA_ALARM_EMAIL")
[[ -z "${LISTORA_DOMAIN:-}" ]] || context+=(--context "domain=$LISTORA_DOMAIN")
[[ -z "${LISTORA_HOSTED_ZONE_ID:-}" ]] || context+=(--context "hostedZoneId=$LISTORA_HOSTED_ZONE_ID")
# As npm run infra:synth does: no AWS credentials or configuration, so nothing can call AWS.
(cd infra && env -i PATH="$PATH" HOME="$HOME" AWS_CONFIG_FILE=/dev/null \
  AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
  npx cdk synth --quiet --no-notices --no-version-reporting --output "$ASSEMBLY" "${context[@]}") \
  >"$workdir/synth.log" 2>&1 || { cat "$workdir/synth.log" >&2; fail "cdk synth failed"; }
info "synthesized to infra/$ASSEMBLY (deployed as is, so what is checked here is what deploys)"
template() { echo "infra/$ASSEMBLY/listora-$ENVIRONMENT-$1.template.json"; }
for name in "${stacks[@]}"; do
  count=$(jq '.Resources | length' "$(template "$name")")
  types=$(jq -r '[.Resources[].Type | sub("^AWS::"; "")] | group_by(.) | map("\(length) \(.[0])") | join(", ")' "$(template "$name")")
  info "listora-$ENVIRONMENT-$name: $count resources ($types)"
done

container_env() {
  jq -r --arg container "$1" --arg key "$2" '.Resources[] | select(.Type == "AWS::ECS::TaskDefinition")
    | .Properties.ContainerDefinitions[] | select(.Name == $container)
    | .Environment[]? | select(.Name == $key) | .Value' "$(template compute)" | head -n 1
}
auth_driver=$(container_env api AUTH_DRIVER)
ai_provider=$(container_env api AI_PROVIDER)
# The dev driver writes sign-in codes to the API log and lets anyone ask for one, so it never
# runs here: personal signs in only with its user pool (docs/features/auth.md).
[[ "$auth_driver" == cognito ]] ||
  fail "the api container would run AUTH_DRIVER '$auth_driver'; personal signs in only with its Cognito user pool"
[[ "$(jq '[.Resources[] | select(.Type == "AWS::Cognito::UserPool") | .Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly] == [true]' "$(template auth)")" == true ]] ||
  fail "the user pool would allow self sign-up"
[[ "$(jq -r '[.Resources[] | select(.Type == "AWS::Cognito::UserPoolUser") | .Properties.Username] | join(",")' "$(template auth)")" == "$owner_email" ]] ||
  fail "the user pool's only user must be $owner_email"
info "sign-in: the Cognito user pool, no sign-up, and $owner_email its only user"
[[ "$ai_provider" != fake && -n "$ai_provider" ]] || fail "the api container would run the fake AI provider"
[[ "$(container_env worker AI_PROVIDER)" == "$ai_provider" ]] || fail "the worker's AI_PROVIDER differs from the api's"
info "api: AUTH_DRIVER=$auth_driver, AI_PROVIDER=$ai_provider (the fake AI is off)"
[[ "$(jq '[.Resources[] | select(.Type == "AWS::RDS::DBInstance") | .Properties.DeletionProtection] | all' "$(template data)")" == true ]] ||
  fail "the database would deploy without deletion protection"
info "database: deletion protection on"

node infra/src/deploy/execution-policy.ts "$ENVIRONMENT" "$EXPECTED_ACCOUNT" >"$workdir/policy.json"
info "restricted CDK execution policy $policy_name: $(jq '.Statement | length' "$workdir/policy.json") statements, $(jq -c '[.Statement[0].Action[] | sub(":\\*$"; "")]' "$workdir/policy.json")"

# --- 5. Restricted CDK bootstrap -------------------------------------------------------------
# Listora's own bootstrap (infra/src/bootstrap.ts; infra/cdk.json makes every cdk command use
# it), so the account's default CDKToolkit and the apps that use it are never touched.
readonly qualifier=listora
readonly toolkit=CDKToolkit-listora
step "Make sure Listora's CDK bootstrap ($toolkit) uses the restricted execution policy"
bootstrap_flags="--qualifier $qualifier --toolkit-stack-name $toolkit --cloudformation-execution-policies $policy_arn --termination-protection"
# shellcheck disable=SC2206 # the flags above have no spaces inside a value
bootstrap=(cdk_ bootstrap "aws://$EXPECTED_ACCOUNT/$region" --app "$ASSEMBLY" $bootstrap_flags)
if [[ "$dry_run" == true && "$code_only" == true ]]; then
  would "aws cloudformation describe-stacks --stack-name $toolkit; aws iam get-policy-version --policy-arn $policy_arn  (refuse unless both are current: --code-only changes neither)"
elif [[ "$dry_run" == true ]]; then
  would "aws iam create-policy --policy-name $policy_name --policy-document file://<the policy above>  (or a new default version when it differs)"
  would "npx cdk bootstrap aws://$EXPECTED_ACCOUNT/$region --profile <profile> $bootstrap_flags  (only when $toolkit does not exist; refuse one with another policy)"
else
  # First, before changing anything: an existing bootstrap must be this restricted one.
  bootstrapped=false
  if toolkit_stack=$(aws_ cloudformation describe-stacks --stack-name "$toolkit" --output json 2>"$workdir/err"); then
    policies=$(jq -r '.Stacks[0].Parameters[]? | select(.ParameterKey == "CloudFormationExecutionPolicies") | .ParameterValue' <<<"$toolkit_stack")
    [[ "$policies" == "$policy_arn" ]] ||
      fail "$toolkit runs CloudFormation with '${policies:-AdministratorAccess (the default)}', not $policy_arn; re-bootstrap it on purpose: npx cdk bootstrap aws://$EXPECTED_ACCOUNT/$region --profile $profile $bootstrap_flags"
    bootstrapped=true
  else
    grep -q 'does not exist' "$workdir/err" || fail "cannot describe $toolkit: $(cat "$workdir/err")"
    [[ "$code_only" == false ]] || fail "$toolkit does not exist yet; deploy in full (without --code-only)"
  fi
  if aws_ iam get-policy --policy-arn "$policy_arn" --output json >"$workdir/existing-policy.json" 2>"$workdir/err"; then
    version=$(jq -r '.Policy.DefaultVersionId' "$workdir/existing-policy.json")
    aws_ iam get-policy-version --policy-arn "$policy_arn" --version-id "$version" \
      --query PolicyVersion.Document --output json >"$workdir/current.json"
    if [[ "$(jq -S . "$workdir/current.json")" == "$(jq -S . "$workdir/policy.json")" ]]; then
      info "$policy_name is up to date ($version)"
    else
      [[ "$code_only" == false ]] ||
        fail "$policy_name differs from the committed document (infra/src/deploy/execution-policy.ts); deploy in full (without --code-only) to update it"
      versions=$(aws_ iam list-policy-versions --policy-arn "$policy_arn" --query 'length(Versions)' --output text)
      [[ "$versions" -lt 5 ]] ||
        fail "$policy_name already has 5 versions; delete an old non-default one, then run this again"
      aws_ iam create-policy-version --policy-arn "$policy_arn" \
        --policy-document "file://$workdir/policy.json" --set-as-default >/dev/null
      info "$policy_name updated to the committed document"
    fi
  else
    grep -q 'NoSuchEntity' "$workdir/err" || fail "cannot read $policy_arn: $(cat "$workdir/err")"
    [[ "$code_only" == false ]] || fail "$policy_name does not exist yet; deploy in full (without --code-only)"
    aws_ iam create-policy --policy-name "$policy_name" \
      --description "Listora $ENVIRONMENT: what CloudFormation may change in CDK deploys (infra/src/deploy/execution-policy.ts)" \
      --policy-document "file://$workdir/policy.json" --tags Key=project,Value=listora >/dev/null
    info "created $policy_name"
  fi

  if [[ "$bootstrapped" == true ]]; then
    info "$toolkit uses $policy_arn"
  else
    "${bootstrap[@]}" || fail "cdk bootstrap failed"
    info "bootstrapped with $policy_arn"
  fi
fi

deploy_stacks() {
  local names=()
  for name in "$@"; do names+=("listora-$ENVIRONMENT-$name"); done
  if [[ "$dry_run" == true ]]; then
    would "npx cdk deploy --app $ASSEMBLY --require-approval never ${names[*]}"
  else
    cdk_ deploy --app "$ASSEMBLY" --require-approval never "${names[@]}" || fail "cdk deploy of ${names[*]} failed (CloudFormation rolled the failed stack back; see infra/README.md, Rollback)"
  fi
}

# --- The deployed services, read and moved directly (ECS) --------------------------------------
compute_output() {
  aws_ cloudformation describe-stacks --stack-name "listora-$ENVIRONMENT-compute" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
# The task definition CloudFormation made for the stack's one task, the migrate stack's.
stack_task_definition() {
  aws_ cloudformation list-stack-resources --stack-name "listora-$ENVIRONMENT-$1" \
    --query "StackResourceSummaries[?ResourceType=='AWS::ECS::TaskDefinition'].PhysicalResourceId" \
    --output text
}
# One "<service> <task definition>" line per service of the compute stack, with the task
# definition CloudFormation made for it: the synthesized template names each service and the
# logical id of its task definition, and the stack's resources give that id's ARN.
service_task_definitions() {
  aws_ cloudformation list-stack-resources --stack-name "listora-$ENVIRONMENT-compute" \
    --query "StackResourceSummaries[?ResourceType=='AWS::ECS::TaskDefinition'].[LogicalResourceId,PhysicalResourceId]" \
    --output json >"$workdir/task-definitions.json" || return 1
  jq -r --slurpfile ids "$workdir/task-definitions.json" '
    ($ids[0] | map({key: .[0], value: .[1]}) | from_entries) as $arns
    | .Resources[] | select(.Type == "AWS::ECS::Service")
    | "\(.Properties.ServiceName) \($arns[.Properties.TaskDefinition.Ref] // "unknown")"' "$(template compute)"
}
running_task_definition() {
  aws_ ecs describe-services --cluster "$cluster" --services "$1" \
    --query 'services[0].taskDefinition' --output text
}
# The image tags a task definition runs, one per line (the commit's tag, for every container).
image_tags() {
  aws_ ecs describe-task-definition --task-definition "$1" \
    --query 'taskDefinition.containerDefinitions[].image' --output text |
    tr '\t' '\n' | sed 's/.*://' | sort -u
}
# The commit the services run now, from their images (empty when they run several, or before
# the first deploy). A --code-only deploy compares the migrations against it, and the build
# reuses its images' layers.
deployed_commit() {
  local tags="" service definition
  while read -r service definition <&3; do
    tags+=$(image_tags "$(running_task_definition "$service")")$'\n'
  done 3<<<"$(service_task_definitions)"
  tags=$(sort -u <<<"$tags" | sed '/^$/d')
  [[ "$tags" == *$'\n'* ]] || echo "$tags"
}
# Registers a revision of task definition $1 that runs this commit's images; everything else
# (roles, environment, secrets, sizes, health checks, logging, tags) stays as CloudFormation
# made it. Prints the new revision's ARN.
register_revision() {
  aws_ ecs describe-task-definition --task-definition "$1" --include TAGS --output json \
    >"$workdir/definition.json" || return 1
  jq --arg repositories "$registry/listora/" --arg tag "$image_tag" '
    .tags as $tags
    | .taskDefinition
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
        .registeredAt, .registeredBy, .deregisteredAt)
    | .containerDefinitions |= map(
        if (.image | startswith($repositories)) then .image |= sub(":[^:]+$"; ":" + $tag) else . end)
    | if ($tags | length) > 0 then .tags = $tags else . end' "$workdir/definition.json" \
    >"$workdir/revision.json"
  aws_ ecs register-task-definition --cli-input-json "file://$workdir/revision.json" \
    --query taskDefinition.taskDefinitionArn --output text
}
# Waits until service $1 runs task definition $2 and nothing else (its rollout COMPLETED), 10
# minutes at most. When the circuit breaker rolls the deployment back, this fails: a deploy
# never reports tasks that did not start as deployed.
wait_for_rollout() {
  local state=""
  for _ in $(seq 120); do
    state=$(aws_ ecs describe-services --cluster "$cluster" --services "$1" --output json | jq -r --arg arn "$2" '
      (.services[0].deployments // []) as $all
      | ($all | map(select(.status == "PRIMARY")) | .[0]) as $primary
      | if $primary == null then "missing"
        elif $primary.taskDefinition != $arn then
          "rolled-back \($all | map(select(.taskDefinition == $arn)) | .[0].rolloutStateReason // "no reason given")"
        elif $primary.rolloutState == "FAILED" then "failed \($primary.rolloutStateReason // "no reason given")"
        elif $primary.rolloutState == "COMPLETED" and ($all | length) == 1 then "done"
        else "waiting (\($primary.runningCount) of \($primary.desiredCount) tasks running)" end') ||
      fail "cannot read the $1 service"
    case "$state" in
      done) return 0 ;;
      missing) fail "the $1 service has no deployment" ;;
      rolled-back*) fail "ECS rolled the $1 service back to its previous task definition: ${state#rolled-back } (logs: /listora/$ENVIRONMENT/<container>)" ;;
      failed*) fail "the $1 service's deployment failed: ${state#failed }" ;;
    esac
    sleep 5
  done
  fail "the $1 service has not finished its deployment after 10 minutes: $state"
}
start_rollout() {
  aws_ ecs update-service --cluster "$cluster" --service "$1" --task-definition "$2" >/dev/null ||
    fail "cannot update the $1 service"
}

deployed_tag=""
if [[ "$code_only" == true ]]; then
  # --- 6. What is deployed --------------------------------------------------------------------
  step "Compare with what is deployed (--code-only deploys no infrastructure change)"
  if [[ "$dry_run" == true ]]; then
    would "aws cloudformation get-template --stack-name listora-$ENVIRONMENT-<each stack>  (refuse unless each equals the synthesized one but for the image tag)"
    would "aws secretsmanager get-secret-value --secret-id listora/$ENVIRONMENT/anthropic-api-key  (refuse a new key)"
    would "aws ecs describe-services --cluster <ClusterName> --services <each service>  (the commit they run)"
  else
    # The image tag (the commit) is the one difference code makes to the templates.
    normalize='walk(if type == "string" and test("^:[0-9a-f]{40}$") then ":<image tag>" else . end)'
    pids=()
    for name in "${stacks[@]}"; do
      aws_ cloudformation get-template --stack-name "listora-$ENVIRONMENT-$name" --template-stage Original \
        --query TemplateBody --output json >"$workdir/deployed-$name.json" 2>"$workdir/deployed-$name.err" &
      pids+=("$!")
    done
    changed=()
    for index in "${!stacks[@]}"; do
      name=${stacks[$index]}
      wait "${pids[$index]}" ||
        fail "cannot read the template of listora-$ENVIRONMENT-$name: $(cat "$workdir/deployed-$name.err")"
      [[ "$(jq -S "$normalize" "$workdir/deployed-$name.json")" == "$(jq -S "$normalize" "$(template "$name")")" ]] ||
        changed+=("listora-$ENVIRONMENT-$name")
    done
    reasons=()
    ((${#changed[@]} == 0)) || reasons+=("the infrastructure differs from what is deployed in ${changed[*]}")
    current=$(aws_ secretsmanager get-secret-value --secret-id "listora/$ENVIRONMENT/anthropic-api-key" \
      --query SecretString --output text) || fail "cannot read listora/$ENVIRONMENT/anthropic-api-key"
    [[ "$current" == "$anthropic_key" ]] || reasons+=("the Anthropic key in $anthropic_env is new")
    unset current
    if ((${#reasons[@]} > 0)); then
      for reason in "${reasons[@]}"; do info "$reason"; done
      fail "this commit needs the full deploy (nothing was changed): scripts/deploy-personal.sh --profile $profile"
    fi
    info "every stack matches the synthesized templates but for the image tag, and the Anthropic key is unchanged"
    cluster=$(compute_output ClusterName)
    deployed_tag=$(deployed_commit) || fail "cannot read the services of $cluster"
    info "the services run ${deployed_tag:-several commits}"
  fi
fi

# --- 7. Registry and image -------------------------------------------------------------------
if [[ "$code_only" == false ]]; then
  step "Deploy the image repository"
  deploy_stacks registry
  if [[ "$dry_run" == false && "$compute_existed" == true ]]; then
    cluster=$(compute_output ClusterName)
    deployed_tag=$(deployed_commit) || deployed_tag=""
  fi
fi

step "Build and push the application and browser runner images"
# The Dockerfile's `app` stage (api, worker, migrations) and `runner` stage (the same sources with
# headless Chromium), each in its own repository, as .github/workflows/deploy.yml builds them.
# ECS runs the tasks on X86_64 (infra/src/stacks/compute-stack.ts), whatever this machine is.
# Each image carries its layer cache (inline), and a build reuses the deployed images' layers as
# well as the builder's own cache, so only the layers whose inputs changed are built and pushed.
[[ "$dry_run" == true ]] || aws_ ecr get-login-password |
  "$container_cli" login --username AWS --password-stdin "$registry" >/dev/null ||
  fail "cannot log in to $registry"
for target in app runner; do
  target_image="$registry/listora/$target:$image_tag"
  cache=(--cache-to type=inline)
  if [[ -n "$deployed_tag" ]]; then
    cache+=(--cache-from "type=registry,ref=$registry/listora/$target:$deployed_tag")
    [[ "$target" == app ]] || cache+=(--cache-from "type=registry,ref=$registry/listora/app:$deployed_tag")
  fi
  if [[ "$dry_run" == true ]]; then
    would "aws ecr describe-images --repository-name listora/$target --image-ids imageTag=$image_tag  (skip the build when it exists)"
    would "$container_cli build --platform linux/amd64 --target $target --tag $target_image ${cache[*]} [--cache-from <the deployed $target image>] ."
    would "$container_cli push $target_image"
  elif aws_ ecr describe-images --repository-name "listora/$target" --image-ids "imageTag=$image_tag" >/dev/null 2>&1; then
    info "$target_image already exists; reusing it"
  else
    "$container_cli" build --platform linux/amd64 --target "$target" --tag "$target_image" "${cache[@]}" . ||
      fail "the $target image build failed"
    "$container_cli" push "$target_image" || fail "the $target image push failed"
  fi
done

if [[ "$code_only" == true ]]; then
  # --- 8. Migrations, only new ones ---------------------------------------------------------
  step "Run the schema migrations if the commit changes any"
  if [[ "$dry_run" == true ]]; then
    would "git diff --quiet <the deployed commit> HEAD -- $MIGRATIONS  (skip when none changed)"
    would "aws ecs register-task-definition  (the migrate stack's task definition with this commit's image)"
    would "AWS_PROFILE=<profile> AWS_REGION=$region scripts/run-migrations.sh $ENVIRONMENT deploy-personal-${image_tag:0:12} <that revision>"
  elif [[ -n "$deployed_tag" ]] && git cat-file -e "$deployed_tag^{commit}" 2>/dev/null &&
    git diff --quiet "$deployed_tag" HEAD -- "$MIGRATIONS"; then
    info "no migration changed since ${deployed_tag:0:12}, which the services run; skipped"
  else
    if [[ -z "$deployed_tag" ]]; then
      info "the services run several commits, so the migrations run"
    elif ! git cat-file -e "$deployed_tag^{commit}" 2>/dev/null; then
      info "this checkout does not have ${deployed_tag:0:12}, which the services run, so the migrations run"
    else
      info "$MIGRATIONS changed since ${deployed_tag:0:12}, which the services run"
    fi
    migrate_definition=$(stack_task_definition migrate) || fail "cannot read listora-$ENVIRONMENT-migrate"
    migrate_revision=$(register_revision "$migrate_definition") ||
      fail "cannot register a revision of $migrate_definition"
    info "migrate task: ${migrate_revision##*/}"
    AWS_PROFILE="$profile" AWS_REGION="$region" scripts/run-migrations.sh "$ENVIRONMENT" "deploy-personal-${image_tag:0:12}" "$migrate_revision" ||
      fail "the schema migrations failed; no new service task started (logs: /listora/$ENVIRONMENT/migrate)"
  fi

  # --- 9. Services ----------------------------------------------------------------------------
  step "Move the services to the new images (ECS directly; CloudFormation is not involved)"
  if [[ "$dry_run" == true ]]; then
    would "aws ecs register-task-definition  (each service's task definition from the compute stack, with this commit's images)"
    would "aws ecs update-service --cluster <ClusterName> --service <each service> --task-definition <its new revision>"
    would "aws ecs describe-services  (until each service runs only its new revision, 10 minutes at most; a rollback fails the deploy)"
  else
    definitions=$(service_task_definitions) || fail "cannot read the services of listora-$ENVIRONMENT-compute"
    moved=()
    while read -r service definition <&3; do
      [[ "$definition" != unknown ]] || fail "listora-$ENVIRONMENT-compute has no task definition for the $service service"
      if [[ "$(image_tags "$(running_task_definition "$service")")" == "$image_tag" ]]; then
        info "$service: already runs $image_tag"
        continue
      fi
      revision=$(register_revision "$definition") || fail "cannot register a revision of $definition"
      start_rollout "$service" "$revision"
      info "$service: rolling out ${revision##*/}"
      moved+=("$service" "$revision")
    done 3<<<"$definitions"
    for ((index = 0; index < ${#moved[@]}; index += 2)); do
      wait_for_rollout "${moved[$index]}" "${moved[$((index + 1))]}"
      info "${moved[$index]}: runs only ${moved[$((index + 1))]##*/}"
    done
  fi
else
  # --- 8. State stacks, the Anthropic key, and migrations ---------------------------------------
  step "Deploy the state stacks and the migration task"
  deploy_stacks network secrets registry data storage email migrate

  # The user pool emails the sign-in codes through SES, which (in its sandbox) sends only to
  # verified addresses. The email stack made the owner's address an SES identity, and SES emailed
  # them a link; until it is clicked, no code can reach them. With a domain, the codes come from
  # no-reply@<domain>, whose DKIM records verify the domain within minutes.
  identities=("$owner_email")
  [[ -z "${LISTORA_DOMAIN:-}" ]] || identities+=("$LISTORA_DOMAIN")
  step "Wait until SES has verified ${identities[*]} (the sign-in codes are emailed through SES)"
  if [[ "$dry_run" == true ]]; then
    would "aws sesv2 get-email-identity --email-identity <each of ${identities[*]}>  (until it is verified, 30 minutes at most)"
  else
    for identity in "${identities[@]}"; do
      verified=false
      for attempt in $(seq 180); do
        status=$(aws_ sesv2 get-email-identity --email-identity "$identity" \
          --query VerifiedForSendingStatus --output text) || fail "cannot read the SES identity $identity"
        if [[ "$status" == True || "$status" == true ]]; then
          verified=true
          break
        fi
        if [[ "$attempt" == 1 && "$identity" == "$owner_email" ]]; then
          info "waiting for you: open the email \"Amazon Web Services - Email Address Verification Request\" sent to $owner_email and click its link"
          info "(not there? resend it: aws ses verify-email-identity --email-address $owner_email --profile $profile --region $region)"
        fi
        sleep 10
      done
      [[ "$verified" == true ]] ||
        fail "SES has not verified $identity yet; click the verification link (or wait for the domain's DKIM records), then run this again"
      info "$identity: verified"
    done
  fi

  step "Deploy the user pool (sign-in for $owner_email only)"
  deploy_stacks auth

  step "Store the Anthropic key in Secrets Manager (listora/$ENVIRONMENT/anthropic-api-key)"
  secret_changed=false
  if [[ "$dry_run" == true ]]; then
    would "aws secretsmanager put-secret-value --secret-id listora/$ENVIRONMENT/anthropic-api-key --secret-string file://<private temp file>  (only when it differs; never printed)"
  else
    current=$(aws_ secretsmanager get-secret-value --secret-id "listora/$ENVIRONMENT/anthropic-api-key" \
      --query SecretString --output text) || fail "cannot read listora/$ENVIRONMENT/anthropic-api-key"
    if [[ "$current" == "$anthropic_key" ]]; then
      info "already set"
    else
      (umask 077 && printf '%s' "$anthropic_key" >"$workdir/anthropic")
      aws_ secretsmanager put-secret-value --secret-id "listora/$ENVIRONMENT/anthropic-api-key" \
        --secret-string "file://$workdir/anthropic" >/dev/null
      rm -f "$workdir/anthropic"
      secret_changed=true
      info "stored (not shown)"
    fi
    unset current
  fi

  step "Run the schema migrations"
  # The migrate stack's own task definition: after a --code-only deploy the family's newest
  # revision runs that deploy's image, which may not be this commit's.
  if [[ "$dry_run" == true ]]; then
    would "AWS_PROFILE=<profile> AWS_REGION=$region scripts/run-migrations.sh $ENVIRONMENT deploy-personal-${image_tag:0:12} <the migrate stack's task definition>"
  else
    migrate_definition=$(stack_task_definition migrate) || fail "cannot read listora-$ENVIRONMENT-migrate"
    AWS_PROFILE="$profile" AWS_REGION="$region" scripts/run-migrations.sh "$ENVIRONMENT" "deploy-personal-${image_tag:0:12}" "$migrate_definition" ||
      fail "the schema migrations failed; no new service task started (logs: /listora/$ENVIRONMENT/migrate)"
  fi

  # --- 9. Services ----------------------------------------------------------------------------
  step "Deploy the services and alarms"
  deploy_stacks compute observability
  if [[ "$dry_run" == false && "$compute_existed" == true ]]; then
    cluster=$(compute_output ClusterName)
    # CloudFormation updates a service only when its template changes, so after a --code-only
    # deploy, deploying the commit it last deployed (a rollback) would leave the service on the
    # newer images: point each service back at the task definition the stack made for it.
    definitions=$(service_task_definitions) || fail "cannot read the services of listora-$ENVIRONMENT-compute"
    moved=()
    while read -r service definition <&3; do
      [[ "$definition" != unknown && "$(running_task_definition "$service")" != "$definition" ]] || continue
      start_rollout "$service" "$definition"
      moved+=("$service" "$definition")
    done 3<<<"$definitions"
    for ((index = 0; index < ${#moved[@]}; index += 2)); do
      wait_for_rollout "${moved[$index]}" "${moved[$((index + 1))]}"
      info "${moved[$index]}: back on the stack's task definition ${moved[$((index + 1))]##*/}"
    done
    if [[ "$secret_changed" == true ]]; then
      # Tasks read secrets when they start, so running tasks need replacing to see the new key.
      for service in $(aws_ ecs list-services --cluster "$cluster" --query 'serviceArns[]' --output text); do
        aws_ ecs update-service --cluster "$cluster" --service "$service" --force-new-deployment >/dev/null
        aws_ ecs wait services-stable --cluster "$cluster" --services "$service"
      done
      info "restarted the services so they read the new Anthropic key"
    fi
  fi
fi

# --- 10. Health and smoke test ---------------------------------------------------------------
step "Wait for the API to be healthy"
if [[ "$dry_run" == true ]]; then
  would "aws cloudformation describe-stacks --stack-name listora-$ENVIRONMENT-compute  (the ApiUrl output)"
  would "curl <ApiUrl>/health/ready until it answers 200 with the database ok (10 minutes at most)"
else
  api_url=$(compute_output ApiUrl)
  [[ "$api_url" == https://* ]] || fail "the compute stack has no ApiUrl output"
  ready=""
  for _ in $(seq 120); do
    if ready=$(curl --silent --fail --max-time 10 "$api_url/health/ready"); then break; fi
    sleep 5
  done
  [[ "$ready" == *'"database":"ok"'* ]] || fail "$api_url never reported ready: ${ready:-no answer} (logs: $api_log_group)"
  info "$api_url/health/ready: $ready"
fi

# The owner pool has no smoke user, so the signed-in steps (create and delete an item) run only
# with LISTORA_SMOKE_ID_TOKEN, an ID token of the owner's (infra/README.md).
step "Smoke test (health, no access without a token, the dev sign-in off; with LISTORA_SMOKE_ID_TOKEN, create and delete an item)"
smoke=(node infra/src/deploy/smoke.ts --api-url)
smoke_auth=(--auth cognito)
if [[ "$dry_run" == true ]]; then
  would "AWS_PROFILE=<profile> AWS_REGION=$region ${smoke[*]} <ApiUrl> ${smoke_auth[*]}"
else
  AWS_PROFILE="$profile" AWS_REGION="$region" "${smoke[@]}" "$api_url" "${smoke_auth[@]}" ||
    fail "the smoke test failed against $api_url (see above; rollback: infra/README.md)"
fi

elapsed="$((SECONDS / 60))m $((SECONDS % 60))s"
if [[ "$dry_run" == true ]]; then
  printf '\ndeploy-personal: dry run ok; nothing was sent to AWS. Deploy with: scripts/deploy-personal.sh --profile <profile>%s\n' \
    "$([[ "$code_only" == false ]] || echo ' --code-only')"
elif [[ "$code_only" == true ]]; then
  printf '\ndeploy-personal: deployed %s (code only) in %s\n\n  API URL: %s\n' "$image_tag" "$elapsed" "$api_url"
else
  printf '\ndeploy-personal: deployed %s in %s\n\n  API URL: %s\n\n' "$image_tag" "$elapsed" "$api_url"
  app_client_id=$(aws_ cloudformation describe-stacks --stack-name "listora-$ENVIRONMENT-auth" \
    --query "Stacks[0].Outputs[?OutputKey=='AppClientId'].OutputValue" --output text)
  printf 'Point the iPhone app at it, in apps/ios/Config/Prod.xcconfig:\n\n'
  printf '  API_BASE_URL = %s\n' "${api_url/:\/\//:\/\$()\/}"
  printf '  COGNITO_REGION = %s\n  COGNITO_CLIENT_ID = %s\n\n' "$region" "$app_client_id"
  # shellcheck disable=SC2016 # a literal $(), as the xcconfig needs
  printf '(the $() keeps xcconfig from reading // as a comment), then ship a TestFlight build.\n'
  printf 'Sign in from Settings with %s: the app emails you a one-time code.\n' "$owner_email"
fi
