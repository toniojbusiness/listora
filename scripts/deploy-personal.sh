#!/usr/bin/env bash
# One-command deploy of the personal environment (infra/README.md, Deploying the personal
# environment). Run from a clean checkout of the commit to deploy; the image is tagged with it.
#
# Usage: scripts/deploy-personal.sh --profile <aws profile> [--dry-run] [--anthropic-env <file>]
#
#   --profile        AWS CLI profile of the personal account (or AWS_PROFILE). Passed to every
#                    aws and cdk command; the script never exports credentials.
#   --dry-run        Run every offline check (tools, synthesis with the real settings, the
#                    restricted execution policy, template invariants) and print each step
#                    and command without calling AWS.
#   --anthropic-env  File with the ANTHROPIC_API_KEY=... line (default
#                    ~/.config/listora/anthropic.env). The key is never printed.
#
# Optional settings, from the environment (.env.example): LISTORA_AWS_REGION (us-east-1),
# LISTORA_AVAILABILITY_ZONES, LISTORA_ALARM_EMAIL, LISTORA_DOMAIN with LISTORA_HOSTED_ZONE_ID,
# and LISTORA_CONTAINER_CLI (docker).
#
# Steps: verify the account; check the zones and the existing stacks; synthesize offline; make
# sure the restricted CDK bootstrap is in place (create its execution policy and bootstrap if
# the account has none, refuse if it has another); deploy the registry; build and push the
# image; deploy the state stacks and the migration task; store the Anthropic key; run the
# migrations; deploy the services and alarms; wait for health; run the smoke test; print the
# API URL. It never deletes or replaces anything that already exists: a stack in a failed state
# or a bootstrap it did not make stops it with the reason.
set -euo pipefail

# The captain's personal AWS account. Deploying anywhere else is refused.
readonly EXPECTED_ACCOUNT=976033325938
readonly ENVIRONMENT=personal

cd "$(dirname "${BASH_SOURCE[0]}")/.."
readonly ASSEMBLY=cdk.out/deploy-$ENVIRONMENT

dry_run=false
profile=${AWS_PROFILE:-}
anthropic_env="$HOME/.config/listora/anthropic.env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
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
readonly stacks=(registry network secrets data storage email migrate compute observability)

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
if [[ "$dry_run" == true ]]; then
  would "aws ec2 describe-availability-zones  (refuse a zone without API Gateway VPC links, use1-az3)"
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
fi

# --- 4. Offline synthesis and template checks ------------------------------------------------
step "Synthesize the stacks offline with the real settings"
context=(--context "env=$ENVIRONMENT" --context "account=$EXPECTED_ACCOUNT" --context "region=$region"
  --context "imageTag=$image_tag")
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
[[ "$auth_driver" == dev || "$auth_driver" == cognito ]] || fail "unexpected AUTH_DRIVER '$auth_driver' in the api container"
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
if [[ "$dry_run" == true ]]; then
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
  fi
  if aws_ iam get-policy --policy-arn "$policy_arn" --output json >"$workdir/existing-policy.json" 2>"$workdir/err"; then
    version=$(jq -r '.Policy.DefaultVersionId' "$workdir/existing-policy.json")
    aws_ iam get-policy-version --policy-arn "$policy_arn" --version-id "$version" \
      --query PolicyVersion.Document --output json >"$workdir/current.json"
    if [[ "$(jq -S . "$workdir/current.json")" == "$(jq -S . "$workdir/policy.json")" ]]; then
      info "$policy_name is up to date ($version)"
    else
      versions=$(aws_ iam list-policy-versions --policy-arn "$policy_arn" --query 'length(Versions)' --output text)
      [[ "$versions" -lt 5 ]] ||
        fail "$policy_name already has 5 versions; delete an old non-default one, then run this again"
      aws_ iam create-policy-version --policy-arn "$policy_arn" \
        --policy-document "file://$workdir/policy.json" --set-as-default >/dev/null
      info "$policy_name updated to the committed document"
    fi
  else
    grep -q 'NoSuchEntity' "$workdir/err" || fail "cannot read $policy_arn: $(cat "$workdir/err")"
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

# --- 6. Registry and image -------------------------------------------------------------------
step "Deploy the image repository"
deploy_stacks registry

step "Build and push the application and browser runner images"
# The Dockerfile's `app` stage (api, worker, migrations) and `runner` stage (the same sources with
# headless Chromium), each in its own repository, as .github/workflows/deploy.yml builds them.
# ECS runs the tasks on X86_64 (infra/src/stacks/compute-stack.ts), whatever this machine is.
[[ "$dry_run" == true ]] || aws_ ecr get-login-password |
  "$container_cli" login --username AWS --password-stdin "$registry" >/dev/null ||
  fail "cannot log in to $registry"
for target in app runner; do
  target_image="$registry/listora/$target:$image_tag"
  if [[ "$dry_run" == true ]]; then
    would "aws ecr describe-images --repository-name listora/$target --image-ids imageTag=$image_tag  (skip the build when it exists)"
    would "$container_cli build --platform linux/amd64 --target $target --tag $target_image ."
    would "$container_cli push $target_image"
  elif aws_ ecr describe-images --repository-name "listora/$target" --image-ids "imageTag=$image_tag" >/dev/null 2>&1; then
    info "$target_image already exists; reusing it"
  else
    "$container_cli" build --platform linux/amd64 --target "$target" --tag "$target_image" . ||
      fail "the $target image build failed"
    "$container_cli" push "$target_image" || fail "the $target image push failed"
  fi
done

# --- 7. State stacks, the Anthropic key, and migrations --------------------------------------
step "Deploy the state stacks and the migration task"
deploy_stacks network secrets registry data storage email migrate

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
if [[ "$dry_run" == true ]]; then
  would "AWS_PROFILE=<profile> AWS_REGION=$region scripts/run-migrations.sh $ENVIRONMENT deploy-personal-${image_tag:0:12}"
else
  AWS_PROFILE="$profile" AWS_REGION="$region" scripts/run-migrations.sh "$ENVIRONMENT" "deploy-personal-${image_tag:0:12}" ||
    fail "the schema migrations failed; no new service task started (logs: /listora/$ENVIRONMENT/migrate)"
fi

# --- 8. Services -----------------------------------------------------------------------------
step "Deploy the services and alarms"
deploy_stacks compute observability
if [[ "$dry_run" == false && "$secret_changed" == true && "$compute_existed" == true ]]; then
  # Tasks read secrets when they start, so running tasks need replacing to see the new key.
  cluster=$(aws_ cloudformation describe-stacks --stack-name "listora-$ENVIRONMENT-compute" \
    --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)
  for service in $(aws_ ecs list-services --cluster "$cluster" --query 'serviceArns[]' --output text); do
    aws_ ecs update-service --cluster "$cluster" --service "$service" --force-new-deployment >/dev/null
    aws_ ecs wait services-stable --cluster "$cluster" --services "$service"
  done
  info "restarted the services so they read the new Anthropic key"
fi

# --- 9. Health and smoke test ----------------------------------------------------------------
step "Wait for the API to be healthy"
if [[ "$dry_run" == true ]]; then
  would "aws cloudformation describe-stacks --stack-name listora-$ENVIRONMENT-compute  (the ApiUrl output)"
  would "curl <ApiUrl>/health/ready until it answers 200 with the database ok (10 minutes at most)"
else
  api_url=$(aws_ cloudformation describe-stacks --stack-name "listora-$ENVIRONMENT-compute" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
  [[ "$api_url" == https://* ]] || fail "the compute stack has no ApiUrl output"
  ready=""
  for _ in $(seq 60); do
    if ready=$(curl --silent --fail --max-time 10 "$api_url/health/ready"); then break; fi
    sleep 10
  done
  [[ "$ready" == *'"database":"ok"'* ]] || fail "$api_url never reported ready: ${ready:-no answer} (logs: $api_log_group)"
  info "$api_url/health/ready: $ready"
fi

step "Smoke test (health, sign-in with the $auth_driver driver, create and delete an item)"
smoke=(node infra/src/deploy/smoke.ts --api-url)
if [[ "$auth_driver" == dev ]]; then smoke_auth=(--auth dev --log-group "$api_log_group"); else smoke_auth=(--auth cognito); fi
if [[ "$dry_run" == true ]]; then
  would "AWS_PROFILE=<profile> AWS_REGION=$region ${smoke[*]} <ApiUrl> ${smoke_auth[*]}"
else
  AWS_PROFILE="$profile" AWS_REGION="$region" "${smoke[@]}" "$api_url" "${smoke_auth[@]}" ||
    fail "the smoke test failed against $api_url (see above; rollback: infra/README.md)"
fi

if [[ "$dry_run" == true ]]; then
  printf '\ndeploy-personal: dry run ok; nothing was sent to AWS. Deploy with: scripts/deploy-personal.sh --profile <profile>\n'
else
  printf '\ndeploy-personal: deployed %s\n\n  API URL: %s\n\n' "$image_tag" "$api_url"
  printf 'Point the iPhone app at it: set API_BASE_URL = %s in apps/ios/Config/Prod.xcconfig\n' "${api_url/:\/\//:\/\$()\/}"
  # shellcheck disable=SC2016 # a literal $(), as the xcconfig needs
  printf '(the $() keeps xcconfig from reading // as a comment), then ship a TestFlight build.\n'
fi
